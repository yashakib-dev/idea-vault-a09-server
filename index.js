const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { EventEmitter } = require("events");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify, SignJWT } = require("jose-cjs");
const rateLimit = require("express-rate-limit");
const { createClient } = require("redis");

dotenv.config();

const uri = process.env.MONGODB_URI;
const PORT = process.env.PORT || 5000;
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.BETTER_AUTH_SECRET ||
  "default-fallback-secret-for-jwt-32-bytes!!";
const secretKey = new TextEncoder().encode(JWT_SECRET);

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Lazy connection promise — reused across serverless invocations
let _connectPromise = null;
const connectOnce = () => {
  if (!_connectPromise) {
    _connectPromise = client.connect().catch((err) => {
      _connectPromise = null; // allow retry on next invocation
      throw err;
    });
  }
  return _connectPromise;
};

// JOSE Token Utilities
const signAccessToken = async (payload, expiresIn = "1h") => {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey);
};

const refreshAccessToken = async (token) => {
  if (!token) {
    throw new Error("Missing token to refresh");
  }

  // Verify signature while allowing expired claims
  const { payload } = await jwtVerify(token, secretKey, {
    currentDate: new Date(0),
  });

  const { exp, iat, nbf, jti, ...userPayload } = payload;
  const refreshedToken = await signAccessToken(userPayload, "1h");
  return { token: refreshedToken, payload: userPayload };
};

const createDefaultJwtVerifier = async (token) => {
  if (!token) {
    throw new Error("Missing token");
  }

  // First try secret key for local/refreshed tokens
  try {
    return await jwtVerify(token, secretKey);
  } catch (err) {
    // If not local HS256, verify via JWKS from Better Auth client URL
    if (process.env.CLIENT_URL) {
      const jwks = createRemoteJWKSet(
        new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
      );
      return await jwtVerify(token, jwks);
    }
    throw err;
  }
};

const createCommentStream = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

  return {
    subscribe(ideaId, res) {
      const onComment = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      emitter.on(`comment:${ideaId}`, onComment);
      return () => {
        emitter.off(`comment:${ideaId}`, onComment);
      };
    },
    broadcast(ideaId, event) {
      emitter.emit(`comment:${ideaId}`, event);
    },
  };
};

const createRedisClient = (url = process.env.REDIS_URL) => {
  if (!url) {
    return null;
  }

  const redis = createClient({ url });
  redis.on("error", (err) => {
    console.warn("Redis Client Error:", err.message);
  });

  return redis;
};

const createCacheService = (redisClient = null) => {
  let isConnected = false;

  if (redisClient) {
    if (redisClient.isOpen) {
      isConnected = true;
    } else if (typeof redisClient.connect === "function") {
      redisClient
        .connect()
        .then(() => {
          isConnected = true;
        })
        .catch((err) => {
          console.warn("Redis connection failed, continuing without cache:", err.message);
          isConnected = false;
        });
    }
  }

  return {
    async get(key) {
      if (!redisClient || (!isConnected && !redisClient.isOpen)) return null;
      try {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
      } catch (err) {
        console.warn(`Redis get error for key ${key}:`, err.message);
        return null;
      }
    },
    async set(key, value, ttlSeconds = 60) {
      if (!redisClient || (!isConnected && !redisClient.isOpen)) return;
      try {
        await redisClient.set(key, JSON.stringify(value), {
          EX: ttlSeconds,
        });
      } catch (err) {
        console.warn(`Redis set error for key ${key}:`, err.message);
      }
    },
    async del(patternOrKey) {
      if (!redisClient || (!isConnected && !redisClient.isOpen)) return;
      try {
        if (
          typeof redisClient.keys === "function" &&
          typeof patternOrKey === "string" &&
          patternOrKey.includes("*")
        ) {
          const keys = await redisClient.keys(patternOrKey);
          if (keys && keys.length > 0) {
            await redisClient.del(keys);
          } else {
            await redisClient.del(patternOrKey);
          }
        } else {
          await redisClient.del(patternOrKey);
        }
      } catch (err) {
        console.warn(`Redis del error for key ${patternOrKey}:`, err.message);
      }
    },
  };
};

const createApp = ({
  db = null,
  jwtVerifier = createDefaultJwtVerifier,
  redisClient = null,
  limiter = null,
  commentStream = createCommentStream(),
} = {}) => {
  const app = express();
  // Resolve collections lazily — safe for both serverless (Vercel) and persistent servers.
  // The connectOnce() middleware guarantees the client is connected before any route runs.
  const getDb = () => db || client.db("ideaVault");
  const ideaCollection = new Proxy({}, {
    get: (_, prop) => {
      const col = getDb().collection("idea");
      return typeof col[prop] === "function" ? col[prop].bind(col) : col[prop];
    },
  });
  const commentCollection = new Proxy({}, {
    get: (_, prop) => {
      const col = getDb().collection("comments");
      return typeof col[prop] === "function" ? col[prop].bind(col) : col[prop];
    },
  });
  const usersCollection = new Proxy({}, {
    get: (_, prop) => {
      const col = getDb().collection("users");
      return typeof col[prop] === "function" ? col[prop].bind(col) : col[prop];
    },
  });
  const cache = createCacheService(redisClient);

  const defaultLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests, please try again later." },
  });

  const buildIdQuery = (id) => {
    if (!id) {
      return {};
    }

    return ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
  };

  app.use(cors());
  app.use(express.json());

  // Ensure MongoDB is connected before handling any request (serverless-safe)
  app.use(async (req, res, next) => {
    try {
      await connectOnce();
      next();
    } catch (err) {
      console.error("MongoDB connection failed:", err.message);
      res.status(503).json({ message: "Database unavailable" });
    }
  });

  // Apply rate limiting middleware
  if (limiter !== false) {
    app.use(limiter || defaultLimiter);
  }

  const verifyToken = async (req, res, next) => {
    const authHeader = req?.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Unauthorized access" });
    }

    const token = authHeader?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Unauthorized access" });
    }

    try {
      const { payload } = await jwtVerifier(token);
      req.user = payload;
      return next();
    } catch (error) {
      // Support automatic token refresh if requested by client or error is expired
      if (req.headers["x-auto-refresh"] === "true") {
        try {
          const refreshed = await refreshAccessToken(token);
          res.setHeader("X-Refreshed-Token", refreshed.token);
          req.user = refreshed.payload;
          return next();
        } catch (refreshErr) {
          return res.status(401).json({ message: "Unauthorized access" });
        }
      }
      return res.status(401).json({ message: "Unauthorized access" });
    }
  };

  const optionalVerifyToken = async (req, res, next) => {
    const authHeader = req?.headers.authorization;
    if (!authHeader) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      req.user = null;
      return next();
    }

    try {
      const { payload } = await jwtVerifier(token);
      req.user = payload;
      return next();
    } catch (error) {
      // Support automatic token refresh if client requests it
      if (req.headers["x-auto-refresh"] === "true") {
        try {
          const refreshed = await refreshAccessToken(token);
          res.setHeader("X-Refreshed-Token", refreshed.token);
          req.user = refreshed.payload;
          return next();
        } catch {
          // Fall through — optional auth, so just continue without user
        }
      }
      req.user = null;
      return next();
    }
  };

  // Automatic token refresh endpoint (JOSE-CJS)
  app.post("/auth/refresh", async (req, res) => {
    const token =
      req.body?.token || req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(400).json({ message: "Token is required for refresh" });
    }

    try {
      const refreshed = await refreshAccessToken(token);
      res.json({ token: refreshed.token, user: refreshed.payload });
    } catch (err) {
      res.status(401).json({ message: "Invalid or non-refreshable token" });
    }
  });

  // Comments endpoints
  app.post("/comments", async (req, res) => {
    const commentData = req.body;
    const result = await commentCollection.insertOne(commentData);

    // Invalidate comments cache for this idea
    if (commentData?.ideaId) {
      await cache.del(`comments:idea:${commentData.ideaId}`);
      commentStream.broadcast(commentData.ideaId, {
        type: "comment:created",
        data: { ...commentData, _id: result.insertedId },
      });
    }
    await cache.del("comments:idea:*");

    res.send(result);
  });

  // Real-time SSE comment updates stream
  app.get("/comments/:ideaId/stream", (req, res) => {
    const { ideaId } = req.params;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Initial ping
    res.write(`data: ${JSON.stringify({ type: "connected", ideaId })}\n\n`);

    const unsubscribe = commentStream.subscribe(ideaId, res);

    req.on("close", () => {
      unsubscribe();
    });
  });

  // Hot read endpoint: comment threads cached
  app.get("/comments/:ideaId", async (req, res) => {
    const { ideaId } = req.params;
    const cacheKey = `comments:idea:${ideaId}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.send(cached);
    }

    const result = await commentCollection
      .find({ ideaId })
      .sort({ createdAt: -1 })
      .toArray();

    await cache.set(cacheKey, result, 60);
    res.setHeader("X-Cache", "MISS");
    res.send(result);
  });

  app.delete("/comments/:id", async (req, res) => {
    const { id } = req.params;
    let comment = null;
    if (typeof commentCollection.findOne === "function") {
      comment = await commentCollection.findOne(buildIdQuery(id));
    }
    const result = await commentCollection.deleteOne(buildIdQuery(id));

    if (comment?.ideaId) {
      await cache.del(`comments:idea:${comment.ideaId}`);
      commentStream.broadcast(comment.ideaId, {
        type: "comment:deleted",
        data: { _id: id },
      });
    }
    await cache.del("comments:idea:*");

    res.send(result);
  });

  app.patch("/comments/:id", async (req, res) => {
    const { id } = req.params;
    const updatedComment = req.body;

    let comment = null;
    if (typeof commentCollection.findOne === "function") {
      comment = await commentCollection.findOne(buildIdQuery(id));
    }
    const result = await commentCollection.updateOne(
      buildIdQuery(id),
      {
        $set: {
          comment: updatedComment.comment,
        },
      },
    );

    if (comment?.ideaId) {
      await cache.del(`comments:idea:${comment.ideaId}`);
      commentStream.broadcast(comment.ideaId, {
        type: "comment:updated",
        data: { _id: id, comment: updatedComment.comment },
      });
    }
    await cache.del("comments:idea:*");

    res.send(result);
  });

  // Hot read endpoint: ideas list (featured) cached
  app.get("/ideas", async (req, res) => {
    const cacheKey = "ideas:featured";
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    const result = await ideaCollection.find().limit(6).toArray();
    await cache.set(cacheKey, result, 60);
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  });

  // Hot read endpoint: all-ideas list with filters cached
  app.get("/all-ideas", async (req, res) => {
    const { search, category, startDate, endDate } = req.query;
    const cacheKey = `ideas:all:${search || ""}:${category || ""}:${startDate || ""}:${endDate || ""}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.send(cached);
    }

    const query = {};

    if (search) {
      query.title = {
        $regex: search,
        $options: "i",
      };
    }

    if (category && category !== "All") {
      query.category = category;
    }

    if (startDate || endDate) {
      query.createdAt = {};

      if (startDate) {
        query.createdAt.$gte = startDate;
      }

      if (endDate) {
        query.createdAt.$lte = endDate;
      }
    }

    const result = await ideaCollection.find(query).toArray();
    await cache.set(cacheKey, result, 60);
    res.setHeader("X-Cache", "MISS");
    res.send(result);
  });

  app.post("/ideas", async (req, res) => {
    const ideaData = req.body;
    const result = await ideaCollection.insertOne(ideaData);

    // Invalidate ideas caches
    await cache.del("ideas:featured");
    await cache.del("ideas:all:*");

    res.json(result);
  });

  // Hot read endpoint: single idea cached (optionalVerifyToken — public read access)
  app.get("/ideas/:id", optionalVerifyToken, async (req, res) => {
    const { id } = req.params;
    const cacheKey = `ideas:item:${id}`;

    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    const result = await ideaCollection.findOne(buildIdQuery(id));
    if (result) {
      await cache.set(cacheKey, result, 120);
    }
    res.setHeader("X-Cache", "MISS");
    res.json(result);
  });

  app.get("/my-ideas/:email", async (req, res) => {
    const email = req.params.email;
    const result = await ideaCollection.find({ userEmail: email }).toArray();
    res.json(result);
  });

  app.delete("/ideas/:id", async (req, res) => {
    const { id } = req.params;
    const result = await ideaCollection.deleteOne(buildIdQuery(id));

    // Invalidate ideas caches
    await cache.del("ideas:featured");
    await cache.del("ideas:all:*");
    await cache.del(`ideas:item:${id}`);

    res.send(result);
  });

  app.patch("/ideas/:id", async (req, res) => {
    const { id } = req.params;
    const updatedData = req.body;

    const result = await ideaCollection.updateOne(
      buildIdQuery(id),
      {
        $set: updatedData,
      },
    );

    // Invalidate ideas caches
    await cache.del("ideas:featured");
    await cache.del("ideas:all:*");
    await cache.del(`ideas:item:${id}`);

    res.send(result);
  });

  app.get("/my-comments/:email", async (req, res) => {
    const { email } = req.params;
    const result = await commentCollection.find({ userEmail: email }).toArray();
    res.send(result);
  });

  app.patch("/users/:email", async (req, res) => {
    const { email } = req.params;
    const updatedData = req.body;

    const result = await usersCollection.updateOne(
      { email },
      { $set: updatedData },
      { upsert: true },
    );

    res.send(result);
  });

  app.get("/users/:email", async (req, res) => {
    const { email } = req.params;
    const user = await usersCollection.findOne({ email });
    res.send(user);
  });

  app.get("/", (req, res) => {
    res.send("Hello World!");
  });

  return app;
};

async function startServer() {
  if (!uri) {
    throw new Error("MONGODB_URI is not defined");
  }

  await client.connect();
  const redisClient = process.env.REDIS_URL ? createRedisClient(process.env.REDIS_URL) : null;
  const app = createApp({ db: client.db("ideaVault"), redisClient });
  const server = app.listen(PORT, () => {
    console.log(`Example app listening on port ${PORT}`);
  });

  return server;
}

// Module-level app for Vercel serverless export.
// connectOnce() middleware (registered inside createApp) handles lazy DB connection per-request.
const app = createApp();

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

// Export the Express app directly as module.exports for @vercel/node compatibility,
// while attaching helpers for testing/integration.
module.exports = app;
module.exports.app = app;
module.exports.createApp = createApp;
module.exports.createDefaultJwtVerifier = createDefaultJwtVerifier;
module.exports.createRedisClient = createRedisClient;
module.exports.createCacheService = createCacheService;
module.exports.createCommentStream = createCommentStream;
module.exports.signAccessToken = signAccessToken;
module.exports.refreshAccessToken = refreshAccessToken;
module.exports.startServer = startServer;
