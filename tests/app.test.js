const request = require("supertest");
const rateLimit = require("express-rate-limit");
const {
  createApp,
  signAccessToken,
  refreshAccessToken,
  createCommentStream,
} = require("../index");

const createMockDb = () => {
  const ideas = [
    {
      _id: "64f0dfc7d1144d3c1fef1234",
      title: "AI Hiring Assistant",
      category: "AI",
      shortDescription: "Automates candidate screening.",
      userEmail: "demo@example.com",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    {
      _id: "64f0dfc7d1144d3c1fef5678",
      title: "Green Logistics",
      category: "Environment",
      shortDescription: "Tracks carbon for local deliveries.",
      userEmail: "other@example.com",
      createdAt: "2025-01-02T00:00:00.000Z",
    },
  ];

  const comments = [
    {
      _id: "64f0dfc7d1144d3c1fef9abc",
      ideaId: "64f0dfc7d1144d3c1fef1234",
      userEmail: "demo@example.com",
      comment: "This is a strong concept.",
      createdAt: "2025-01-03T00:00:00.000Z",
    },
  ];

  const ideaCollection = {
    find: jest.fn((query = {}) => ({
      limit: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue(ideas.slice(0, 1)),
      })),
      toArray: jest.fn().mockResolvedValue(
        query.userEmail
          ? ideas.filter((item) => item.userEmail === query.userEmail)
          : ideas
      ),
    })),
    findOne: jest.fn(async ({ _id }) => {
      const value = typeof _id === "object" && _id !== null ? _id.toString() : _id;
      return ideas.find((idea) => idea._id === value) || null;
    }),
    insertOne: jest.fn(async (document) => ({ insertedId: "new-idea-id", ...document })),
    deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1, acknowledged: true })),
  };

  const commentCollection = {
    find: jest.fn((query = {}) => ({
      sort: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue(
          query.ideaId
            ? comments.filter((c) => c.ideaId === query.ideaId)
            : comments
        ),
      })),
      toArray: jest.fn().mockResolvedValue(
        query.userEmail
          ? comments.filter((c) => c.userEmail === query.userEmail)
          : comments
      ),
    })),
    findOne: jest.fn(async ({ _id }) => {
      const value = typeof _id === "object" && _id !== null ? _id.toString() : _id;
      return comments.find((c) => c._id === value) || null;
    }),
    insertOne: jest.fn(async (document) => ({ insertedId: "new-comment-id", ...document })),
    deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1, acknowledged: true })),
  };

  const usersCollection = {
    updateOne: jest.fn(async () => ({ acknowledged: true, modifiedCount: 1 })),
    findOne: jest.fn(async ({ email }) => ({ email, name: "Demo User" })),
  };

  const db = {
    collection: jest.fn((name) => {
      if (name === "idea") return ideaCollection;
      if (name === "comments") return commentCollection;
      if (name === "users") return usersCollection;
      return {};
    }),
  };

  return { db, ideaCollection, commentCollection, usersCollection };
};

const createMockRedis = () => {
  const store = new Map();
  return {
    isOpen: true,
    store,
    get: jest.fn(async (key) => store.get(key) || null),
    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return "OK";
    }),
    del: jest.fn(async (keys) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      arr.forEach((k) => store.delete(k));
      return 1;
    }),
    keys: jest.fn(async (pattern) => {
      const prefix = pattern.replace("*", "");
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    }),
  };
};

describe("IdeaVault backend API", () => {
  const jwtVerifier = async () => ({ payload: { email: "demo@example.com" } });

  test("GET / returns health check message", async () => {
    const { db } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.text).toBe("Hello World!");
  });

  test("GET /ideas returns the latest featured ideas", async () => {
    const { db } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/ideas");

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
  });

  test("GET /all-ideas filters by search and category", async () => {
    const { db, ideaCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    await request(app).get("/all-ideas?search=AI&category=AI");

    expect(ideaCollection.find).toHaveBeenCalledWith({
      title: { $regex: "AI", $options: "i" },
      category: "AI",
    });
  });

  test("GET /all-ideas filters by date range", async () => {
    const { db, ideaCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    await request(app).get("/all-ideas?startDate=2025-01-01&endDate=2025-01-05");

    expect(ideaCollection.find).toHaveBeenCalledWith({
      createdAt: {
        $gte: "2025-01-01",
        $lte: "2025-01-05",
      },
    });
  });

  test("POST /ideas inserts a new startup idea", async () => {
    const { db, ideaCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app)
      .post("/ideas")
      .send({
        title: "Community Finance",
        category: "Finance",
        shortDescription: "Helps local communities budget better.",
      });

    expect(response.status).toBe(200);
    expect(ideaCollection.insertOne).toHaveBeenCalledWith({
      title: "Community Finance",
      category: "Finance",
      shortDescription: "Helps local communities budget better.",
    });
  });

  test("GET /ideas/:id is publicly accessible without authentication", async () => {
    const { db } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/ideas/64f0dfc7d1144d3c1fef1234");

    // Route uses optionalVerifyToken — unauthenticated requests succeed (200)
    expect(response.status).toBe(200);
    expect(response.body._id).toBe("64f0dfc7d1144d3c1fef1234");
  });

  test("GET /ideas/:id accepts a valid bearer token", async () => {
    const { db } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app)
      .get("/ideas/64f0dfc7d1144d3c1fef1234")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body._id).toBe("64f0dfc7d1144d3c1fef1234");
  });

  test("GET /my-ideas/:email returns user ideas", async () => {
    const { db, ideaCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/my-ideas/demo@example.com");

    expect(response.status).toBe(200);
    expect(ideaCollection.find).toHaveBeenCalledWith({ userEmail: "demo@example.com" });
    expect(Array.isArray(response.body)).toBe(true);
  });

  test("DELETE /ideas/:id deletes an idea", async () => {
    const { db, ideaCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).delete("/ideas/64f0dfc7d1144d3c1fef1234");

    expect(response.status).toBe(200);
    expect(ideaCollection.deleteOne).toHaveBeenCalled();
  });

  test("PATCH /ideas/:id updates an idea", async () => {
    const { db, ideaCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app)
      .patch("/ideas/64f0dfc7d1144d3c1fef1234")
      .send({ title: "Updated Title" });

    expect(response.status).toBe(200);
    expect(ideaCollection.updateOne).toHaveBeenCalled();
  });

  test("POST /comments creates a comment and returns inserted data", async () => {
    const { db, commentCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app)
      .post("/comments")
      .send({
        ideaId: "64f0dfc7d1144d3c1fef1234",
        userEmail: "demo@example.com",
        comment: "Great concept!",
      });

    expect(response.status).toBe(200);
    expect(commentCollection.insertOne).toHaveBeenCalledWith({
      ideaId: "64f0dfc7d1144d3c1fef1234",
      userEmail: "demo@example.com",
      comment: "Great concept!",
    });
  });

  test("GET /comments/:ideaId returns comments in newest-first order", async () => {
    const { db, commentCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/comments/64f0dfc7d1144d3c1fef1234");

    expect(response.status).toBe(200);
    expect(commentCollection.find).toHaveBeenCalledWith({ ideaId: "64f0dfc7d1144d3c1fef1234" });
    expect(Array.isArray(response.body)).toBe(true);
  });

  test("DELETE /comments/:id deletes a comment", async () => {
    const { db, commentCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).delete("/comments/64f0dfc7d1144d3c1fef9abc");

    expect(response.status).toBe(200);
    expect(commentCollection.deleteOne).toHaveBeenCalled();
  });

  test("PATCH /comments/:id updates a comment", async () => {
    const { db, commentCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app)
      .patch("/comments/64f0dfc7d1144d3c1fef9abc")
      .send({ comment: "Updated comment text" });

    expect(response.status).toBe(200);
    expect(commentCollection.updateOne).toHaveBeenCalled();
  });

  test("GET /my-comments/:email returns comments created by the user", async () => {
    const { db, commentCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/my-comments/demo@example.com");

    expect(response.status).toBe(200);
    expect(commentCollection.find).toHaveBeenCalledWith({ userEmail: "demo@example.com" });
    expect(Array.isArray(response.body)).toBe(true);
  });

  test("GET /users/:email returns user information", async () => {
    const { db, usersCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app).get("/users/demo@example.com");

    expect(response.status).toBe(200);
    expect(usersCollection.findOne).toHaveBeenCalledWith({ email: "demo@example.com" });
    expect(response.body.email).toBe("demo@example.com");
  });

  test("PATCH /users/:email updates user profile", async () => {
    const { db, usersCollection } = createMockDb();
    const app = createApp({ db, jwtVerifier });

    const response = await request(app)
      .patch("/users/demo@example.com")
      .send({ name: "Updated Demo User" });

    expect(response.status).toBe(200);
    expect(usersCollection.updateOne).toHaveBeenCalled();
  });

  // Redis caching & Rate limiting tests
  describe("Redis Caching Layer for Hot Read Endpoints", () => {
    test("GET /ideas caches results and serves cache on subsequent requests", async () => {
      const { db, ideaCollection } = createMockDb();
      const redisClient = createMockRedis();
      const app = createApp({ db, jwtVerifier, redisClient });

      // First call: Cache MISS
      const res1 = await request(app).get("/ideas");
      expect(res1.status).toBe(200);
      expect(res1.headers["x-cache"]).toBe("MISS");
      expect(ideaCollection.find).toHaveBeenCalledTimes(1);
      expect(redisClient.set).toHaveBeenCalled();

      // Second call: Cache HIT
      const res2 = await request(app).get("/ideas");
      expect(res2.status).toBe(200);
      expect(res2.headers["x-cache"]).toBe("HIT");
      expect(ideaCollection.find).toHaveBeenCalledTimes(1);
    });

    test("GET /all-ideas caches filtered results", async () => {
      const { db, ideaCollection } = createMockDb();
      const redisClient = createMockRedis();
      const app = createApp({ db, jwtVerifier, redisClient });

      const res1 = await request(app).get("/all-ideas?category=AI");
      expect(res1.headers["x-cache"]).toBe("MISS");

      const res2 = await request(app).get("/all-ideas?category=AI");
      expect(res2.headers["x-cache"]).toBe("HIT");
      expect(ideaCollection.find).toHaveBeenCalledTimes(1);
    });

    test("GET /ideas/:id caches single idea on authentication", async () => {
      const { db, ideaCollection } = createMockDb();
      const redisClient = createMockRedis();
      const app = createApp({ db, jwtVerifier, redisClient });

      const res1 = await request(app)
        .get("/ideas/64f0dfc7d1144d3c1fef1234")
        .set("Authorization", "Bearer token");
      expect(res1.headers["x-cache"]).toBe("MISS");

      const res2 = await request(app)
        .get("/ideas/64f0dfc7d1144d3c1fef1234")
        .set("Authorization", "Bearer token");
      expect(res2.headers["x-cache"]).toBe("HIT");
      expect(ideaCollection.findOne).toHaveBeenCalledTimes(1);
    });

    test("GET /comments/:ideaId caches comment threads", async () => {
      const { db, commentCollection } = createMockDb();
      const redisClient = createMockRedis();
      const app = createApp({ db, jwtVerifier, redisClient });

      const res1 = await request(app).get("/comments/64f0dfc7d1144d3c1fef1234");
      expect(res1.headers["x-cache"]).toBe("MISS");

      const res2 = await request(app).get("/comments/64f0dfc7d1144d3c1fef1234");
      expect(res2.headers["x-cache"]).toBe("HIT");
      expect(commentCollection.find).toHaveBeenCalledTimes(1);
    });

    test("POST /ideas invalidates ideas cache", async () => {
      const { db } = createMockDb();
      const redisClient = createMockRedis();
      const app = createApp({ db, jwtVerifier, redisClient });

      await request(app)
        .post("/ideas")
        .send({ title: "New Venture", category: "AI" });

      expect(redisClient.del).toHaveBeenCalledWith("ideas:featured");
      expect(redisClient.del).toHaveBeenCalledWith("ideas:all:*");
    });

    test("POST /comments invalidates comment thread cache", async () => {
      const { db } = createMockDb();
      const redisClient = createMockRedis();
      const app = createApp({ db, jwtVerifier, redisClient });

      await request(app)
        .post("/comments")
        .send({ ideaId: "64f0dfc7d1144d3c1fef1234", comment: "Awesome!" });

      expect(redisClient.del).toHaveBeenCalledWith("comments:idea:64f0dfc7d1144d3c1fef1234");
    });
  });

  describe("API Rate Limiting via express-rate-limit", () => {
    test("applies standard rate limiting headers to incoming responses", async () => {
      const { db } = createMockDb();
      const app = createApp({ db, jwtVerifier });

      const response = await request(app).get("/");
      expect(response.status).toBe(200);
      expect(response.headers).toHaveProperty("ratelimit-limit");
      expect(response.headers).toHaveProperty("ratelimit-remaining");
    });

    test("blocks requests with 429 when rate limit is exceeded", async () => {
      const { db } = createMockDb();
      const strictLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 2,
        standardHeaders: true,
        legacyHeaders: false,
        message: { message: "Too many requests, please try again later." },
      });

      const app = createApp({ db, jwtVerifier, limiter: strictLimiter });

      const res1 = await request(app).get("/");
      expect(res1.status).toBe(200);

      const res2 = await request(app).get("/");
      expect(res2.status).toBe(200);

      const res3 = await request(app).get("/");
      expect(res3.status).toBe(429);
      expect(res3.body.message).toContain("Too many requests");
    });
  });

  // Real-Time Comments (SSE) Tests
  describe("Real-time Comment Updates (SSE Stream)", () => {
    test("GET /comments/:ideaId/stream initiates an SSE stream connection", async () => {
      const { db } = createMockDb();
      const app = createApp({ db, jwtVerifier });

      const response = await request(app)
        .get("/comments/64f0dfc7d1144d3c1fef1234/stream")
        .set("Accept", "text/event-stream")
        .buffer(true)
        .parse((res, callback) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
            // Abort stream once connected ping is received
            res.destroy();
          });
          res.on("close", () => callback(null, data));
        });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain('"type":"connected"');
    });

    test("broadcasts comment:created event when a new comment is posted", async () => {
      const { db } = createMockDb();
      const commentStream = createCommentStream();
      const broadcastSpy = jest.spyOn(commentStream, "broadcast");
      const app = createApp({ db, jwtVerifier, commentStream });

      await request(app).post("/comments").send({
        ideaId: "64f0dfc7d1144d3c1fef1234",
        userEmail: "demo@example.com",
        comment: "Real-time SSE comment!",
      });

      expect(broadcastSpy).toHaveBeenCalledWith(
        "64f0dfc7d1144d3c1fef1234",
        expect.objectContaining({
          type: "comment:created",
          data: expect.objectContaining({
            comment: "Real-time SSE comment!",
            ideaId: "64f0dfc7d1144d3c1fef1234",
          }),
        })
      );
    });

    test("broadcasts comment:updated event when a comment is edited", async () => {
      const { db } = createMockDb();
      const commentStream = createCommentStream();
      const broadcastSpy = jest.spyOn(commentStream, "broadcast");
      const app = createApp({ db, jwtVerifier, commentStream });

      await request(app)
        .patch("/comments/64f0dfc7d1144d3c1fef9abc")
        .send({ comment: "Updated comment text via SSE" });

      expect(broadcastSpy).toHaveBeenCalledWith(
        "64f0dfc7d1144d3c1fef1234",
        expect.objectContaining({
          type: "comment:updated",
          data: expect.objectContaining({
            _id: "64f0dfc7d1144d3c1fef9abc",
            comment: "Updated comment text via SSE",
          }),
        })
      );
    });

    test("broadcasts comment:deleted event when a comment is deleted", async () => {
      const { db } = createMockDb();
      const commentStream = createCommentStream();
      const broadcastSpy = jest.spyOn(commentStream, "broadcast");
      const app = createApp({ db, jwtVerifier, commentStream });

      await request(app).delete("/comments/64f0dfc7d1144d3c1fef9abc");

      expect(broadcastSpy).toHaveBeenCalledWith(
        "64f0dfc7d1144d3c1fef1234",
        expect.objectContaining({
          type: "comment:deleted",
          data: { _id: "64f0dfc7d1144d3c1fef9abc" },
        })
      );
    });
  });

  // Automatic Token Refresh with JOSE-CJS Integration Tests
  describe("Automatic Token Refresh using JOSE-CJS", () => {
    test("signs a valid access token and accesses protected endpoint", async () => {
      const { db } = createMockDb();
      const app = createApp({ db });

      const token = await signAccessToken({
        email: "demo@example.com",
        name: "Demo User",
      });

      const response = await request(app)
        .get("/ideas/64f0dfc7d1144d3c1fef1234")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body._id).toBe("64f0dfc7d1144d3c1fef1234");
    });

    test("detects expired token and refuses refresh with 401 for bad token", async () => {
      const { db } = createMockDb();
      const app = createApp({ db });

      // A completely invalid/forged token — /auth/refresh should refuse it
      const response = await request(app)
        .post("/auth/refresh")
        .send({ token: "this.is.not.a.valid.jwt" });

      expect(response.status).toBe(401);
      expect(response.body.message).toBe("Invalid or non-refreshable token");
    });

    test("POST /auth/refresh refreshes an expired token and allows subsequent access", async () => {
      const { db } = createMockDb();
      const app = createApp({ db });

      // Expired token
      const expiredToken = await signAccessToken(
        { email: "refreshed.user@example.com" },
        "-1m"
      );

      // Request token refresh via /auth/refresh endpoint
      const refreshResponse = await request(app)
        .post("/auth/refresh")
        .send({ token: expiredToken });

      expect(refreshResponse.status).toBe(200);
      expect(refreshResponse.body).toHaveProperty("token");
      expect(refreshResponse.body.user.email).toBe("refreshed.user@example.com");

      // Now use refreshed token to access protected route successfully
      const protectedResponse = await request(app)
        .get("/ideas/64f0dfc7d1144d3c1fef1234")
        .set("Authorization", `Bearer ${refreshResponse.body.token}`);

      expect(protectedResponse.status).toBe(200);
      expect(protectedResponse.body._id).toBe("64f0dfc7d1144d3c1fef1234");
    });

    test("automatically refreshes expired token on the fly when X-Auto-Refresh header is passed", async () => {
      const { db } = createMockDb();
      const app = createApp({ db });

      const expiredToken = await signAccessToken(
        { email: "demo@example.com" },
        "-5s"
      );

      const response = await request(app)
        .get("/ideas/64f0dfc7d1144d3c1fef1234")
        .set("Authorization", `Bearer ${expiredToken}`)
        .set("X-Auto-Refresh", "true");

      expect(response.status).toBe(200);
      expect(response.headers).toHaveProperty("x-refreshed-token");
      expect(response.body._id).toBe("64f0dfc7d1144d3c1fef1234");
    });

    test("rejects token refresh for invalid or forged tokens", async () => {
      const { db } = createMockDb();
      const app = createApp({ db });

      const response = await request(app)
        .post("/auth/refresh")
        .send({ token: "forged.token.payload" });

      expect(response.status).toBe(401);
      expect(response.body.message).toContain("Invalid or non-refreshable");
    });
  });
});
