const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
dotenv.config();
const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

 const JWKS = createRemoteJWKSet(
      new URL('http://localhost:3000/api/auth/jwks')
    )

const verifyToken = async(req, res, next) => {
  const authHeader = req?.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized access" });
  }
  const token = authHeader?.split(" ")[1];
  if(!token){
    return res.status(401).json({ message: "Unauthorized access" });
  }
next();

};

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("ideaVault");
    const ideaCollection = db.collection("idea");

    const commentCollection = db.collection("comments");

    app.post("/comments", async (req, res) => {
      const commentData = req.body;

      const result = await commentCollection.insertOne(commentData);

      res.send(result);
    });

    app.get("/comments/:ideaId", async (req, res) => {
      const { ideaId } = req.params;

      const result = await commentCollection
        .find({ ideaId })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.delete("/comments/:id", async (req, res) => {
      const { id } = req.params;

      const result = await commentCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    app.patch("/comments/:id", async (req, res) => {
      const { id } = req.params;

      const updatedComment = req.body;

      const result = await commentCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            comment: updatedComment.comment,
          },
        },
      );

      res.send(result);
    });

    app.get("/ideas", async (req, res) => {
      const result = await ideaCollection.find().limit(6).toArray();
      res.json(result);
    });
    app.get("/all-ideas", async (req, res) => {
      const result = await ideaCollection.find().toArray();
      res.json(result);
    });

    app.post("/ideas", async (req, res) => {
      const ideaData = req.body;
      const result = await ideaCollection.insertOne(ideaData);
      res.json(result);
    });

    app.get("/ideas/:id",verifyToken,async (req, res) => {
      const { id } = req.params;
      const result = await ideaCollection.findOne({ _id: new ObjectId(id) });
      res.json(result);
    });

    app.get("/my-ideas/:email", async (req, res) => {
      const email = req.params.email;

      const result = await ideaCollection.find({ userEmail: email }).toArray();

      res.json(result);
    });

    app.delete("/ideas/:id", async (req, res) => {
      const { id } = req.params;

      const result = await ideaCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    app.patch("/ideas/:id", async (req, res) => {
      const { id } = req.params;
      const updatedData = req.body;

      const result = await ideaCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: updatedData,
        },
      );

      res.send(result);
    });

    app.get("/my-comments/:email", async (req, res) => {
      const { email } = req.params;

      const result = await commentCollection
        .find({ userEmail: email })
        .toArray();

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`);
});
