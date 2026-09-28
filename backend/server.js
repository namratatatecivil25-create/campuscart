require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ALLOWED_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || "").trim().toLowerCase();
const PLATFORM_FEE = 0.05;

// ---------- Models ----------
const User = mongoose.model("User", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  department: { type: String, default: "" },
  year: { type: String, default: "" },
}, { timestamps: true }));

const Listing = mongoose.model("Listing", new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: "" },
  category: { type: String, default: "Other" },
  course: { type: String, default: "" },          // e.g. "Engineering Drawing - FE Sem 1"
  condition: { type: String, default: "Good" },
  mrp: { type: Number, default: 0 },               // price of buying it new
  pricePerDay: { type: Number, required: true, min: 1 },
  deposit: { type: Number, default: 0, min: 0 },
  pickupPoint: { type: String, default: "Main Gate Help Desk" },
  photo: { type: String, default: "" },
  available: { type: Boolean, default: true },
}, { timestamps: true }));

const Booking = mongoose.model("Booking", new mongoose.Schema({
  listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
  renter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  days: { type: Number, required: true, min: 1 },
  rentAmount: Number,
  depositOriginal: Number,
  deposit: Number,            // deposit actually charged (reduced by Campus Karma)
  platformFee: Number,
  ownerEarning: Number,
  saved: { type: Number, default: 0 },   // money saved vs buying new
  status: { type: String, enum: ["booked", "active", "returned", "cancelled"], default: "booked" },
  startedAt: Date, dueAt: Date, returnedAt: Date, onTime: Boolean,
  rating: { type: Number, min: 1, max: 5 },
  review: { type: String, default: "" },
}, { timestamps: true }));

// ---------- Campus Karma (trust score) ----------
// Starts at 50. +10 per on-time return, -15 per late return. Higher karma = lower deposit.
async function karmaFor(userId) {
  const done = await Booking.find({ renter: userId, status: "returned" });
  const onTime = done.filter((b) => b.onTime).length;
  const late = done.length - onTime;
  const score = Math.max(0, Math.min(100, 50 + onTime * 10 - late * 15));
  const level = score >= 80 ? "Campus Star" : score >= 60 ? "Trusted" : "Newcomer";
  const depositFactor = score >= 80 ? 0 : score >= 60 ? 0.5 : 1;
  const totalSaved = (await Booking.find({ renter: userId, status: { $ne: "cancelled" } })).reduce((s, b) => s + (b.saved || 0), 0);
  return { score, level, depositFactor, completed: done.length, onTime, totalSaved };
}

// ---------- Helpers ----------
const sign = (u) => jwt.sign({ id: u._id }, JWT_SECRET, { expiresIn: "7d" });
async function auth(req, res, next) {
  try {
    const { id } = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), JWT_SECRET);
    req.user = await User.findById(id);
    if (!req.user) throw new Error("no user");
    next();
  } catch { res.status(401).json({ error: "Please log in again." }); }
}
const safeUser = (u) => ({ id: u._id, name: u.name, email: u.email, department: u.department, year: u.year });

// ---------- Routes ----------
app.get("/", (req, res) => res.json({ app: "CampusCart API", status: "running" }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, department, year } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    if (ALLOWED_DOMAIN && !email.toLowerCase().endsWith("@" + ALLOWED_DOMAIN))
      return res.status(400).json({ error: `Use your college email (@${ALLOWED_DOMAIN}).` });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: "Email already registered." });
    const user = await User.create({ name, email, department, year, password: await bcrypt.hash(password, 10) });
    res.json({ token: sign(user), user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await User.findOne({ email: (req.body.email || "").toLowerCase() });
    if (!user || !(await bcrypt.compare(req.body.password || "", user.password)))
      return res.status(400).json({ error: "Wrong email or password." });
    res.json({ token: sign(user), user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me/karma", auth, async (req, res) => res.json(await karmaFor(req.user._id)));

app.get("/api/listings", async (req, res) => {
  const { q, category } = req.query;
  const filter = { available: true };
  if (category && category !== "All") filter.category = category;
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: rx }, { course: rx }, { description: rx }];
  }
  res.json(await Listing.find(filter).sort({ createdAt: -1 }).populate("owner", "name department year"));
});

app.post("/api/listings", auth, async (req, res) => {
  try {
    const b = req.body;
    if (!b.title || !b.pricePerDay) return res.status(400).json({ error: "Title and price per day are required." });
    res.json(await Listing.create({ owner: req.user._id, title: b.title, description: b.description, category: b.category,
      course: b.course, condition: b.condition, mrp: Number(b.mrp || 0), pricePerDay: Number(b.pricePerDay),
      deposit: Number(b.deposit || 0), pickupPoint: b.pickupPoint, photo: b.photo }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/listings/mine", auth, async (req, res) => res.json(await Listing.find({ owner: req.user._id }).sort({ createdAt: -1 })));

app.delete("/api/listings/:id", auth, async (req, res) => {
  const l = await Listing.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
  if (!l) return res.status(404).json({ error: "Listing not found." });
  res.json({ ok: true });
});

app.post("/api/bookings", auth, async (req, res) => {
  try {
    const listing = await Listing.findById(req.body.listingId);
    if (!listing || !listing.available) return res.status(400).json({ error: "Item is not available." });
    if (String(listing.owner) === String(req.user._id)) return res.status(400).json({ error: "You cannot rent your own item." });
    const days = Math.max(1, Number(req.body.days) || 1);
    const rentAmount = listing.pricePerDay * days;
    const platformFee = Math.round(rentAmount * PLATFORM_FEE * 100) / 100;
    const k = await karmaFor(req.user._id);
    const booking = await Booking.create({
      listing: listing._id, renter: req.user._id, owner: listing.owner, days, rentAmount,
      depositOriginal: listing.deposit, deposit: Math.round(listing.deposit * k.depositFactor),
      platformFee, ownerEarning: rentAmount - platformFee, saved: Math.max(0, (listing.mrp || 0) - rentAmount),
    });
    listing.available = false;
    await listing.save();
    res.json(booking);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/bookings/mine", auth, async (req, res) => {
  const pop = [{ path: "listing", select: "title photo pickupPoint" }, { path: "renter", select: "name email" }, { path: "owner", select: "name email" }];
  res.json({
    asRenter: await Booking.find({ renter: req.user._id }).sort({ createdAt: -1 }).populate(pop),
    asOwner: await Booking.find({ owner: req.user._id }).sort({ createdAt: -1 }).populate(pop),
  });
});

app.patch("/api/bookings/:id/status", auth, async (req, res) => {
  const b = await Booking.findById(req.params.id);
  if (!b || String(b.owner) !== String(req.user._id)) return res.status(404).json({ error: "Booking not found." });
  const { status } = req.body;
  const allowed = { booked: ["active", "cancelled"], active: ["returned"] };
  if (!(allowed[b.status] || []).includes(status)) return res.status(400).json({ error: `Cannot change from ${b.status} to ${status}.` });
  const now = new Date();
  if (status === "active") { b.startedAt = now; b.dueAt = new Date(now.getTime() + b.days * 86400000); }
  if (status === "returned") { b.returnedAt = now; b.onTime = now <= b.dueAt; }
  b.status = status;
  await b.save();
  if (status === "returned" || status === "cancelled") await Listing.findByIdAndUpdate(b.listing, { available: true });
  res.json(b);
});

app.post("/api/bookings/:id/review", auth, async (req, res) => {
  const b = await Booking.findById(req.params.id);
  if (!b || String(b.renter) !== String(req.user._id)) return res.status(404).json({ error: "Booking not found." });
  if (b.status !== "returned") return res.status(400).json({ error: "You can review after the item is returned." });
  b.rating = Math.min(5, Math.max(1, Number(req.body.rating) || 5));
  b.review = req.body.review || "";
  await b.save();
  res.json(b);
});

app.get("/api/stats", async (req, res) => {
  const [users, listings, bookings, completed] = await Promise.all([
    User.countDocuments(), Listing.countDocuments(), Booking.countDocuments(), Booking.countDocuments({ status: "returned" }),
  ]);
  const agg = await Booking.aggregate([{ $match: { status: "returned" } },
    { $group: { _id: null, fee: { $sum: "$platformFee" }, value: { $sum: "$rentAmount" }, saved: { $sum: "$saved" } } }]);
  res.json({ users, listings, bookings, completedRentals: completed, rentalValue: agg[0]?.value || 0,
    platformRevenue: agg[0]?.fee || 0, studentSavings: agg[0]?.saved || 0, newPurchasesAvoided: completed });
});

const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => app.listen(PORT, () => console.log("CampusCart API running on port " + PORT)))
  .catch((err) => { console.error("MongoDB connection failed:", err.message); process.exit(1); });
