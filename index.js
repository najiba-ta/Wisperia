const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dontenv = require("dotenv");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');
dontenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT || 8000;

// Setup Stripe Webhook BEFORE express.json() to handle raw body signatures
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      // SECURITY: signature verification is mandatory. Without it, anyone can
      // POST an arbitrary "checkout.session.completed" payload to this endpoint
      // and upgrade any userId to Premium for free. There is no safe fallback.
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.error(
          "Stripe Webhook Error: STRIPE_WEBHOOK_SECRET is not configured.",
        );
        return res
          .status(500)
          .send(
            "Webhook Error: Server is not configured to verify Stripe signatures.",
          );
      }
      if (!sig) {
        return res
          .status(400)
          .send("Webhook Error: Missing stripe-signature header.");
      }
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("Stripe Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const userEmail =
        session.metadata?.userEmail || session.customer_details?.email;
      const sessionId = session.id;
      const priceId = session.metadata?.priceId;

      console.log(
        "Stripe checkout completed for user:",
        userId,
        "email:",
        userEmail,
      );

      if (userId) {
        try {
          const db = client.db("wisperia");
          const userCollection = db.collection("user");
          const subscriptionsCollection = db.collection("subscriptions");

          // Check if subscription log already exists
          const isExist = await subscriptionsCollection.findOne({ sessionId });
          if (!isExist) {
            await subscriptionsCollection.insertOne({
              sessionId,
              userEmail,
              userId,
              priceId,
              createdAt: new Date(),
            });
          }

          // Update user: set isPremium to true and plan to premium
          const userRes = await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $set: { plan: "premium", isPremium: true } },
          );
          console.log("Updated user from webhook:", userRes);
        } catch (dbErr) {
          console.error("Database update failed in stripe webhook:", dbErr);
        }
      }
    }

    res.json({ received: true });
  },
);


app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL || "http://localhost:3000"],
  }),
);


const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  limit: 300, 
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30, // tighter limit for endpoints that create content (comments, reports, checkout)
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
);
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ msg: "Unauthorized2" });
  }
  try {
    const { payload } = await jwtVerify(token, JWKS);

    const db = client.db("wisperia");
    const userCollection = db.collection("user");

    const dbUser = await userCollection.findOne({
      _id: new ObjectId(payload.id),
    });
    if (dbUser) {
      req.user = {
        id: dbUser._id.toString(),
        email: dbUser.email,
        name: dbUser.name,
        image: dbUser.image,
        role: dbUser.role || "user",
        plan: dbUser.plan || "free",
        isPremium: dbUser.isPremium || false,
      };
    } else {
      req.user = payload;
    }
    next();
  } catch (error) {
    console.error("Token verification error:", error);
    return res.status(401).json({ msg: "Unauthorized3" });
  }
};

const adminVerify = async (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ msg: "Forbidden" });
  }
  next();
};

async function run() {
  try {
    await client.connect();

    const db = client.db("wisperia");
    const userCollection = db.collection("user");
    const lessonCollection = db.collection("lesson");
    const reportsCollection = db.collection("lessonsReports");
    const favoritesCollection = db.collection("favorites");
    const commentsCollection = db.collection("comments");
    const subscriptionsCollection = db.collection("subscriptions");

    console.log("MongoDB connected!");


    // Create Stripe Checkout Session endpoint
    app.post("/create-checkout-session", writeLimiter, async (req, res) => {
      const { priceId, userId, userEmail } = req.body;
      if (!userId || !userEmail) {
        return res
          .status(400)
          .json({ error: "Missing required user metadata" });
      }

      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const PRICE_ID = priceId || "price_1Tkc4317KfH9DgY0PYSDTlot";

        const session = await stripe.checkout.sessions.create({
          customer_email: userEmail,
          line_items: [
            {
              price: PRICE_ID,
              quantity: 1,
            },
          ],
          metadata: {
            priceId: PRICE_ID,
            userId: userId,
            userEmail: userEmail,
          },
          mode: "payment",
          success_url: `${process.env.CLIENT_URL}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
        });

        res.json({ url: session.url, id: session.id });
      } catch (err) {
        console.error("Create Checkout Session Error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // Subscriptions manual payment log endpoint
    // SECURITY: this endpoint is called by the Next.js success page after a
    // real Stripe Checkout redirect, but it must not blindly trust the body —
    // otherwise anyone could POST { sessionId: "anything", userId: <victim> }
    // directly and get upgraded without ever paying. We re-verify the session
    // with Stripe itself before writing isPremium to the database.
    app.post("/subscriptions", async (req, res) => {
      try {
        const { sessionId, userId, priceId, userEmail } = req.body;

        if (!sessionId || !userId) {
          return res
            .status(400)
            .json({ error: "Missing required sessionId or userId" });
        }

        const isExist = await subscriptionsCollection.findOne({ sessionId });
        if (isExist) {
          return res.json("Already Exist");
        }

        // Verify with Stripe that this session genuinely exists, is paid,
        // and actually belongs to the userId being upgraded.
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        let verifiedSession;
        try {
          verifiedSession = await stripe.checkout.sessions.retrieve(sessionId);
        } catch (stripeErr) {
          return res.status(400).json({ error: "Invalid Stripe session" });
        }

        if (
          verifiedSession.status !== "complete" ||
          verifiedSession.payment_status !== "paid"
        ) {
          return res
            .status(402)
            .json({ error: "Payment not completed for this session" });
        }
        if (verifiedSession.metadata?.userId !== userId) {
          return res
            .status(403)
            .json({ error: "Session does not belong to this user" });
        }

        const result = await subscriptionsCollection.insertOne({
          sessionId,
          userEmail,
          userId,
          priceId,
          createdAt: new Date(),
        });

        // Update user role and isPremium fields
        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { plan: "premium", isPremium: true } },
        );

        res.json({ msg: "Payment Successful!" });
      } catch (err) {
        console.error("Subscription payment log error:", err);
        res
          .status(500)
          .json({ error: "Database operation failed: " + err.message });
      }
    });

    // Add Lesson (protected)
    app.post("/user/add-lesson", verifyToken, async (req, res) => {
      try {
        const data = req.body;

        // Ensure free users cannot post Premium content
        const accessLevelValue = req.user.isPremium
          ? data.accesslevel || data.accessLevel || "free"
          : "free";

        const lesson = {
          title: data.title,
          description: data.description,
          category: data.category,
          emotionalTone: data.emotionaltone || data.emotionalTone,
          emotionaltone: data.emotionaltone || data.emotionalTone,
          visibility: data.visibility || "public",
          accessLevel: accessLevelValue,
          accesslevel: accessLevelValue,
          image: data.image || "",
          likes: [],
          likesCount: 0,
          isFeatured: false,
          isReviewed: false,
          userId: req.user.id,
          creatorName: req.user.name,
          creatorEmail: req.user.email,
          creatorImage: req.user.image,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await lessonCollection.insertOne(lesson);
        res.send(result);
      } catch (err) {
        console.error("Add lesson error:", err);
        res.status(500).json({ error: "Failed to add lesson: " + err.message });
      }
    });

    // Get public lessons (with Search + Filter + Sort + Pagination)
    app.get("/public-lessons", async (req, res) => {
      try {
        const {
          search,
          category,
          emotionalTone,
          sort,
          page = 1,
          limit = 6,
        } = req.query;
        const query = { visibility: "public" };

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } },
          ];
        }

        if (category && category !== "All") {
          query.category = category;
        }

        if (emotionalTone && emotionalTone !== "All") {
          query.$or = query.$or || [];
          query.$or.push(
            { emotionalTone: emotionalTone },
            { emotionaltone: emotionalTone },
          );
        }

        const limitNum = parseInt(limit);
        const skipNum = (parseInt(page) - 1) * limitNum;

        let sortQuery = { createdAt: -1 }; // default newest
        if (sort === "newest") {
          sortQuery = { createdAt: -1 };
        } else if (sort === "mostSaved" || sort === "popular") {
          sortQuery = { likesCount: -1 };
        }

        const lessons = await lessonCollection
          .find(query)
          .sort(sortQuery)
          .skip(skipNum)
          .limit(limitNum)
          .toArray();
        const totalCount = await lessonCollection.countDocuments(query);
        const totalPages = Math.ceil(totalCount / limitNum);

        res.json({
          lessons,
          totalPages,
          currentPage: parseInt(page),
          totalCount,
        });
      } catch (err) {
        console.error("Public lessons fetch error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // Get Single Lesson Details
    app.get("/lessons/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const lesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson) {
          return res.status(404).json({ error: "Lesson not found" });
        }
        res.json(lesson);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Edit Lesson (protected)
    app.put("/lessons/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const data = req.body;

        const existingLesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!existingLesson) {
          return res.status(404).json({ error: "Lesson not found" });
        }

        // Only owners or admins can edit
        if (
          existingLesson.userId !== req.user.id &&
          req.user.role !== "admin"
        ) {
          return res
            .status(403)
            .json({ error: "Unauthorized to edit this lesson" });
        }

        // Owners can change Access Level if they have active Premium subscription
        const accessLevelValue = req.user.isPremium
          ? data.accesslevel || data.accessLevel || "free"
          : "free";

        const updateData = {
          title: data.title,
          description: data.description,
          category: data.category,
          emotionalTone: data.emotionaltone || data.emotionalTone,
          emotionaltone: data.emotionaltone || data.emotionalTone,
          visibility: data.visibility || "public",
          accessLevel: accessLevelValue,
          accesslevel: accessLevelValue,
          updatedAt: new Date(),
        };

        if (data.image) {
          updateData.image = data.image;
        }

        const result = await lessonCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData },
        );

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete Lesson (protected)
    app.delete("/lessons/:id", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const existingLesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!existingLesson) {
          return res.status(404).json({ error: "Lesson not found" });
        }

        // Only owners or admins can delete
        if (
          existingLesson.userId !== req.user.id &&
          req.user.role !== "admin"
        ) {
          return res
            .status(403)
            .json({ error: "Unauthorized to delete this lesson" });
        }

        const result = await lessonCollection.deleteOne({
          _id: new ObjectId(id),
        });

        // Also clean up favorites, reports and comments
        await reportsCollection.deleteMany({ lessonId: id });
        await favoritesCollection.deleteMany({ lessonId: id });
        await commentsCollection.deleteMany({ lessonId: id });

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });


    app.post("/lessons/:id/like", verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const userId = req.user.id;

        const lesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson) {
          return res.status(404).json({ error: "Lesson not found" });
        }

        const likesArray = lesson.likes || [];
        const hasLiked = likesArray.includes(userId);

        let update;
        if (hasLiked) {
          update = {
            $pull: { likes: userId },
            $inc: { likesCount: -1 },
          };
        } else {
          update = {
            $addToSet: { likes: userId },
            $inc: { likesCount: 1 },
          };
        }

        await lessonCollection.updateOne({ _id: new ObjectId(id) }, update);
        const updatedLesson = await lessonCollection.findOne({
          _id: new ObjectId(id),
        });
        res.json({ likesCount: updatedLesson.likesCount, hasLiked: !hasLiked });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Report Lesson (protected)
    app.post(
      "/lessons/:id/report",
      writeLimiter,
      verifyToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { reason } = req.body;

          const lesson = await lessonCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!lesson) {
            return res.status(404).json({ error: "Lesson not found" });
          }

          const report = {
            lessonId: id,
            lessonTitle: lesson.title,
            reporterUserId: req.user.id,
            reportedUserEmail: lesson.creatorEmail || "unknown@domain.com",
            reason: reason || "Inappropriate content",
            timestamp: new Date(),
          };

          const result = await reportsCollection.insertOne(report);
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Toggle Favorite (protected)
    app.post("/favorites/toggle", verifyToken, async (req, res) => {
      try {
        const { lessonId } = req.body;
        const userId = req.user.id;

        const existing = await favoritesCollection.findOne({
          userId,
          lessonId,
        });
        if (existing) {
          await favoritesCollection.deleteOne({ userId, lessonId });
          res.json({ saved: false });
        } else {
          await favoritesCollection.insertOne({
            userId,
            lessonId,
            savedAt: new Date(),
          });
          res.json({ saved: true });
        }
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Check if Favorite exists
    app.get("/favorites/status", verifyToken, async (req, res) => {
      try {
        const { lessonId } = req.query;
        const userId = req.user.id;
        const existing = await favoritesCollection.findOne({
          userId,
          lessonId,
        });
        res.json({ saved: !!existing });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get user favorites (protected)
    app.get("/favorites", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const favs = await favoritesCollection.find({ userId }).toArray();
        const lessonIds = favs.map((f) => new ObjectId(f.lessonId));

        if (lessonIds.length === 0) {
          return res.json([]);
        }

        const lessons = await lessonCollection
          .find({ _id: { $in: lessonIds } })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Add Comment (protected)
    app.post(
      "/lessons/:id/comments",
      writeLimiter,
      verifyToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { text } = req.body;

          const comment = {
            lessonId: id,
            userId: req.user.id,
            userName: req.user.name,
            userImage: req.user.image,
            text: text,
            createdAt: new Date(),
          };

          const result = await commentsCollection.insertOne(comment);
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Get Comments for Lesson
    app.get("/lessons/:id/comments", async (req, res) => {
      try {
        const { id } = req.params;
        const comments = await commentsCollection
          .find({ lessonId: id })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(comments);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get User Dashboard Stats (protected)
    app.get("/user/dashboard-stats", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        console.log(userId,"userId");
        const totalCreated = await lessonCollection.countDocuments({ userId });
        const totalSaved = await favoritesCollection.countDocuments({ userId });
        const recentLessons = await lessonCollection
          .find({ userId })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();
          console.log(totalCreated,totalSaved,recentLessons,"gjfju")

        // Categorized distribution for simple visualization chart
        const categoryStats = await lessonCollection
          .aggregate([
            { $match: { userId } },
            { $group: { _id: "$category", count: { $sum: 1 } } },
          ])
          .toArray();

        res.json({
          totalCreated,
          totalSaved,
          recentLessons,
          categoryStats,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Fetch user public lessons profile grid
    app.get("/user/public-lessons/:userId", async (req, res) => {
      try {
        const { userId } = req.params;
        const lessons = await lessonCollection
          .find({ userId, visibility: "public" })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Fetch all lessons created by current user
    app.get("/user/my-lessons", verifyToken, async (req, res) => {
      try {
        const lessons = await lessonCollection
          .find({ userId: req.user.id })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ADMIN ENDPOINTS
    // Admin Dashboard stats
    app.get("/admin/stats", verifyToken, adminVerify, async (req, res) => {
      try {
        const totalUsers = await userCollection.countDocuments();
        const totalPublicLessons = await lessonCollection.countDocuments({
          visibility: "public",
        });
        const totalReported = await reportsCollection.countDocuments();
         
        // Today's new lessons count
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const todayNewLessons = await lessonCollection.countDocuments({
          createdAt: { $gte: startOfToday },
        });

        // Most active contributors (top 5 users by created lessons)
        const activeContributors = await lessonCollection
          .aggregate([
            {
              $group: {
                _id: "$userId",
                count: { $sum: 1 },
                name: { $first: "$creatorName" },
                email: { $first: "$creatorEmail" },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ])
          .toArray();

        res.json({
          totalUsers,
          totalPublicLessons,
          totalReported,
          todayNewLessons,
          activeContributors,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Manage Users list (admin only)
    app.get("/admin/users", verifyToken, adminVerify, async (req, res) => {
      try {
        // Fetch all users with lessons count
        const users = await userCollection.find().toArray();
        const usersWithCount = await Promise.all(
          users.map(async (u) => {
            const count = await lessonCollection.countDocuments({
              userId: u._id.toString(),
            });
            return {
              ...u,
              lessonsCount: count,
            };
          }),
        );
        res.json(usersWithCount);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Update User Role (admin only)
    app.put(
      "/admin/users/:id/role",
      verifyToken,
      adminVerify,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } },
          );
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Delete User (admin only)
    app.delete(
      "/admin/users/:id",
      verifyToken,
      adminVerify,
      async (req, res) => {
        try {
          const { id } = req.params;
          const result = await userCollection.deleteOne({
            _id: new ObjectId(id),
          });
          // Clean up user's lessons
          await lessonCollection.deleteMany({ userId: id });
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Manage Lessons list (admin only)
    app.get("/admin/lessons", verifyToken, adminVerify, async (req, res) => {
      try {
        const lessons = await lessonCollection.find().toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Toggle Feature Lesson (admin only)
    app.put(
      "/admin/lessons/:id/featured",
      verifyToken,
      adminVerify,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { isFeatured } = req.body;
          const result = await lessonCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isFeatured } },
          );
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Mark reviewed (admin only)
    app.put(
      "/admin/lessons/:id/reviewed",
      verifyToken,
      adminVerify,
      async (req, res) => {
        try {
          const { id } = req.params;
          const result = await lessonCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { isReviewed: true } },
          );
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Get Reported Lessons List (admin only)
    app.get(
      "/admin/reported-lessons",
      verifyToken,
      adminVerify,
      async (req, res) => {
        try {
          // Group reports by lessonId
          const reportGroups = await reportsCollection
            .aggregate([
              {
                $group: {
                  _id: "$lessonId",
                  count: { $sum: 1 },
                  lessonTitle: { $first: "$lessonTitle" },
                  reports: {
                    $push: {
                      reporterUserId: "$reporterUserId",
                      reportedUserEmail: "$reportedUserEmail",
                      reason: "$reason",
                      timestamp: "$timestamp",
                    },
                  },
                },
              },
            ])
            .toArray();

          res.json(reportGroups);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Ignore reported lesson (admin only)
    app.post(
      "/admin/reported-lessons/:id/ignore",
      verifyToken,
      adminVerify,
      async (req, res) => {
        try {
          const { id } = req.params;
          // Delete all reports for this lesson
          const result = await reportsCollection.deleteMany({ lessonId: id });
          res.json(result);
        } catch (err) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    // Update profile display name and image (protected)
    app.put("/user/profile", verifyToken, async (req, res) => {
      // console.log("req.user:", req.user);
      // console.log("req.body:", req.body);
      try {
        const { name, image } = req.body;
        const updateData = {};
        if (name) updateData.name = name;
        if (image) updateData.image = image;

        const result = await userCollection.updateOne(
          { _id: new ObjectId(req.user.id) },
          { $set: updateData },
        );

        // Also update creator info on their lessons
        if (name || image) {
          const lessonsUpdate = {};
          if (name) lessonsUpdate.creatorName = name;
          if (image) lessonsUpdate.creatorImage = image;

          await lessonCollection.updateMany(
            { userId: req.user.id },
            { $set: lessonsUpdate },
          );
        }

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get featured lessons list for Home Page
    app.get("/featured-lessons", async (req, res) => {
      try {
        const lessons = await lessonCollection
          .find({ isFeatured: true, visibility: "public" })
          .toArray();
        res.json(lessons);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get contributors and statistics for Home Page
    app.get("/home-stats", async (req, res) => {
      try {
        // Top 5 Contributors of the Week (users with most public lessons created)
        const topContributors = await lessonCollection
          .aggregate([
            { $match: { visibility: "public" } },
            {
              $group: {
                _id: "$userId",
                count: { $sum: 1 },
                name: { $first: "$creatorName" },
                image: { $first: "$creatorImage" },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 6 },
          ])
          .toArray();

        // Most Saved/Liked Lessons
        const mostSaved = await lessonCollection
          .find({ visibility: "public" })
          .sort({ likesCount: -1 })
          .limit(6)
          .toArray();

        res.json({
          topContributors,
          mostSaved,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

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
  res.send("Server is running fine!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
