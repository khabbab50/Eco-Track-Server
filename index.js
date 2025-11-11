// server.js (native MongoDB driver, no mongoose)
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- MongoDB setup ----------
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://ecoTrack:PWXCgOydasBvIHpy@cluster0.q4wcqfi.mongodb.net/ecoTrack?retryWrites=true&w=majority";

const client = new MongoClient(MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  useUnifiedTopology: true,
});

let db;
let Collections = {};

async function initDb() {
  await client.connect();
  db = client.db(process.env.DB_NAME || "ecoTrack");

  // ---------- Ensure collections exist ----------
  await db.createCollection("challenges").catch(() => {});
  await db.createCollection("userChallenges").catch(() => {});
  await db.createCollection("tips").catch(() => {});
  await db.createCollection("events").catch(() => {});

  Collections.challenges = db.collection("challenges");
  Collections.userChallenges = db.collection("userChallenges");
  Collections.tips = db.collection("tips");
  Collections.events = db.collection("events");

  // Ensure indexes (unique slug, unique user-challenge pair, date/geo indexes optional)
  await Collections.challenges.createIndex({ slug: 1 }, { unique: true });
  await Collections.userChallenges.createIndex(
    { user: 1, challenge: 1 },
    { unique: true }
  );
  await Collections.challenges.createIndex({ startDate: 1 });
  await Collections.events.createIndex({ date: 1 });
  // geospatial indexes only if you use location fields:

  console.log("MongoDB connected and indexes ensured");
}
initDb().catch((err) => {
  console.error("Failed to initialize DB", err);
  process.exit(1);
});

// ---------- Simple Auth Middleware (mock / placeholder) ----------
async function authMiddleware(req, res, next) {
  const header = req.header("Authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing Authorization header" });
  }
  const token = header.split(" ")[1];

  // Mock logic:
  if (token === "mock-admin") {
    req.user = {
      uid: "mock-admin",
      isAdmin: true,
      id: "000000000000000000000001",
    };
    return next();
  }
  if (token && token.startsWith("mock-user:")) {
    const id = token.split(":")[1] || null;
    // validate id length maybe
    req.user = { uid: token, isAdmin: false, id };
    return next();
  }

  // If you want real firebase-admin verification, add logic here when configured.
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return res.status(401).json({
      message: "Real Firebase verification not implemented in this template",
    });
  }

  return res
    .status(401)
    .json({ message: "Invalid token (use mock-admin or mock-user:<id>)" });
}

// ---------- Helpers ----------
function parseDateSafe(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function buildChallengeFilters(q) {
  const filters = { isPublished: { $in: [true, null] } };
  if (q.category) {
    const cats = q.category
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (cats.length) filters.category = { $in: cats };
  }
  if (q.startDate || q.endDate) {
    // We will filter challenges with startDate between given bounds
    const from = parseDateSafe(q.startDate);
    const to = parseDateSafe(q.endDate);
    if (from || to) {
      filters.startDate = {};
      if (from) filters.startDate.$gte = from;
      if (to) filters.startDate.$lte = to;
    }
  }
  if (q.participantsMin || q.participantsMax) {
    filters.participants = {};
    if (q.participantsMin)
      filters.participants.$gte = parseInt(q.participantsMin, 10);
    if (q.participantsMax)
      filters.participants.$lte = parseInt(q.participantsMax, 10);
  }
  if (q.search) {
    const re = new RegExp(q.search, "i");
    filters.$or = [{ title: re }, { description: re }, { tags: re }];
  }
  return filters;
}

// ---------- Routes ----------
const router = express.Router();

/**
 * /challenges
 */
router.get("/challenges", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(100, parseInt(req.query.limit || "10", 10));
    const skip = (page - 1) * limit;

    const filters = buildChallengeFilters(req.query);

    const [items, total] = await Promise.all([
      Collections.challenges
        .find(filters)
        .sort({ startDate: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      Collections.challenges.countDocuments(filters),
    ]);

    res.json({ page, limit, total, items });
  } catch (err) {
    console.error("/challenges error", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * /challenges/:id
 */
router.get("/challenges/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid id" });
    const c = await Collections.challenges.findOne({ _id: new ObjectId(id) });
    if (!c) return res.status(404).json({ message: "Not found" });
    res.json(c);
  } catch (err) {
    console.error("/challenges/:id", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * /challenges  (protected)
 */
router.post("/challenges", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const body = req.body || {};
    const required = ["title", "slug", "description", "startDate", "endDate"];
    for (const f of required) {
      if (!body[f])
        return res.status(400).json({ message: `Missing field: ${f}` });
    }
    const startDate = parseDateSafe(body.startDate);
    const endDate = parseDateSafe(body.endDate);
    if (!startDate || !endDate)
      return res.status(400).json({ message: "Invalid date format" });

    const doc = {
      title: body.title,
      slug: body.slug,
      description: body.description,
      category: body.category || null,
      tags: Array.isArray(body.tags) ? body.tags : body.tags ? [body.tags] : [],
      owner: req.user.id ? new ObjectId(req.user.id) : null,
      startDate,
      endDate,
      participants:
        typeof body.participants === "number" ? body.participants : 0,
      maxParticipants: body.maxParticipants || null,
      location: body.location || null,
      image: body.image || null,
      isPublished:
        typeof body.isPublished === "boolean" ? body.isPublished : true,
      metadata: body.metadata || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await Collections.challenges.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error("/challenges", err);
    if (err.code === 11000)
      return res.status(409).json({ message: "Slug already exists" });
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * /challenges/:id  (owner or admin)
 */
router.patch("/challenges/:id", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid id" });

    const existing = await Collections.challenges.findOne({
      _id: new ObjectId(id),
    });
    if (!existing) return res.status(404).json({ message: "Not found" });

    const isOwner =
      existing.owner &&
      req.user.id &&
      existing.owner.toString() === req.user.id;
    if (!isOwner && !req.user.isAdmin)
      return res.status(403).json({ message: "Forbidden" });

    const data = { ...req.body };
    if (data.startDate) data.startDate = parseDateSafe(data.startDate);
    if (data.endDate) data.endDate = parseDateSafe(data.endDate);
    data.updatedAt = new Date();

    // Prevent change of immutable fields if you want (e.g., owner)
    const update = { $set: data };

    const r = await Collections.challenges.findOneAndUpdate(
      { _id: new ObjectId(id) },
      update,
      { returnDocument: "after" }
    );
    res.json(r.value);
  } catch (err) {
    console.error("/challenges/:id", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * /challenges/:id
 */
router.delete("/challenges/:id", authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    const id = req.params.id;
    if (!ObjectId.isValid(id))
      return res.status(400).json({ message: "Invalid id" });

    const existing = await Collections.challenges.findOne({
      _id: new ObjectId(id),
    });
    if (!existing) return res.status(404).json({ message: "Not found" });

    const isOwner =
      existing.owner &&
      req.user.id &&
      existing.owner.toString() === req.user.id;
    if (!isOwner && !req.user.isAdmin)
      return res.status(403).json({ message: "Forbidden" });

    await Collections.challenges.deleteOne({ _id: new ObjectId(id) });
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("/challenges/:id", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * /challenges/join/:id
 */
router.post("/challenges/join/:id", authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  const userId = req.user.id;
  if (!userId || !ObjectId.isValid(userId)) {
    return res.status(400).json({
      message:
        "Your mock-user token must include a valid ObjectId after colon (mock-user:<id>)",
    });
  }

  const challengeId = req.params.id;
  if (!ObjectId.isValid(challengeId))
    return res.status(400).json({ message: "Invalid challenge id" });

  const session = client.startSession();
  try {
    let createdUC = null;
    await session.withTransaction(async () => {
      const challenge = await Collections.challenges.findOne(
        { _id: new ObjectId(challengeId) },
        { session }
      );
      if (!challenge) throw { code: 404, message: "Challenge not found" };

      if (
        challenge.maxParticipants &&
        challenge.participants >= challenge.maxParticipants
      ) {
        throw { code: 400, message: "Challenge is full" };
      }

      // create userChallenge doc
      const ucDoc = {
        user: new ObjectId(userId),
        challenge: new ObjectId(challengeId),
        joinedAt: new Date(),
        progress: 0,
        status: "joined",
        meta: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Insert userChallenge (this will fail with duplicate key if already exists)
      await Collections.userChallenges.insertOne(ucDoc, { session });

      // increment participants
      await Collections.challenges.updateOne(
        { _id: new ObjectId(challengeId) },
        { $inc: { participants: 1 }, $set: { updatedAt: new Date() } },
        { session }
      );

      createdUC = ucDoc;
    });

    session.endSession();
    res.status(201).json({ message: "Joined", userChallenge: createdUC });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();
    console.error("JOIN error", err);
    if (err && err.code === 11000)
      return res
        .status(409)
        .json({ message: "User already joined this challenge" });
    if (err && err.code === 404)
      return res.status(404).json({ message: err.message || "Not found" });
    if (err && err.code === 400)
      return res.status(400).json({ message: err.message || "Bad request" });
    return res.status(500).json({ message: "Failed to join" });
  }
});

// ---------- Tips & Events ----------
router.get("/tips", async (req, res) => {
  try {
    const tips = await Collections.tips
      .find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();
    res.json(tips);
  } catch (err) {
    console.error("/tips", err);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/events", async (req, res) => {
  try {
    const now = new Date();
    const events = await Collections.events
      .find({})
      .sort({ date: 1 })
      .limit(4)
      .toArray();
    res.json(events);
  } catch (err) {
    console.error("/events", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.use("/", router);

// root
app.get("/", (req, res) => {
  res.send("EcoTrack Server (native MongoDB) is running");
});

app.listen(port, () => {
  console.log(`EcoTrack Server running on port ${port}`);
});
