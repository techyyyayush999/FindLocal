# Phase 2 — Shops + Geolocation: Technical Implementation Plan

> **Status**: Planning only. No files created or modified.
> **Prerequisite**: Phase 0 (Backend Foundation) ✅ and Phase 1 (Auth & Authorization) ✅

---

## 1. Shop Mongoose Schema

**File:** `server/src/models/Shop.model.js`

The schema has three logical sections: identity, location, and status.

```
Shop {
  owner          : ObjectId  → ref: 'User'   [required, unique]
  name           : String    [required, trim, maxlength: 100]
  description    : String    [optional, trim, maxlength: 500]
  address        : String    [required, trim, maxlength: 300]
  phone          : String    [optional, trim]
  location       : GeoJSON Point (see §3)
  isOpen         : Boolean   [default: false]
  isVerified     : Boolean   [default: false]
  verifiedAt     : Date      [optional]
  verifiedBy     : ObjectId  → ref: 'User'   [optional]
  timestamps     : true      (createdAt, updatedAt auto-managed by Mongoose)
}
```

**Key design decisions:**
- `owner` is `unique: true` — one seller, one shop. Enforced at DB level via unique index.
- `isVerified` starts `false`. Admin manually flips it to `true` after review.
- `verifiedAt` and `verifiedBy` are set only when admin verifies — creates a useful audit trail.
- `isOpen` is seller-controlled and independent of verification. A shop can be verified but currently closed.
- No `rejectedReason` field yet — keep it simple; can be added in a later phase.
- No `category` or `images` yet — out of scope for this phase.

---

## 2. Seller–Shop Relationship

- **One-to-One**: A seller (`User` with `role: 'seller'`) owns exactly one `Shop`.
- The relationship is stored on the **Shop side** via `owner: ObjectId → User`.
- The `User` model is **not modified** — no `shop` reference is added to the User.

**Why on the Shop side?**
- Simpler. Users exist before shops; the shop references its owner.
- Querying "find shop for this seller" is a simple `Shop.findOne({ owner: req.user._id })`.
- Avoids circular references and extra fields on the User document.

**Uniqueness enforcement:**
- `owner` field has `unique: true` in the schema → MongoDB enforces one shop per seller at the index level.
- Controller also checks manually and returns a clear 409 error before hitting a duplicate-key crash.

---

## 3. GeoJSON Structure

MongoDB's geospatial queries require the **GeoJSON Point** format:

```json
{
  "type": "Point",
  "coordinates": [longitude, latitude]
}
```

**Critical rule:** coordinates are `[longitude, latitude]` — NOT `[latitude, longitude]`. This is GeoJSON standard and the most common beginner mistake (see §16).

In the schema:

```
location: {
  type: {
    type: String,
    enum: ['Point'],
    required: true
  },
  coordinates: {
    type: [Number],   // [longitude, latitude]
    required: true
  }
}
```

**Validation constraints applied in the validator:**
- `coordinates` must be an array of exactly 2 numbers.
- Longitude: –180 to +180
- Latitude: –90 to +90

**Frontend sends:**
```json
{
  "location": {
    "coordinates": [77.2090, 28.6139]
  }
}
```
The controller sets `type: 'Point'` server-side — the client never needs to send it.

---

## 4. 2dsphere Index

Defined directly on the schema using `index()`:

```js
shopSchema.index({ location: '2dsphere' });
```

**Why 2dsphere?**
- Required for all MongoDB geospatial queries (`$geoNear`, `$near`, `$within`).
- Works on a sphere (Earth), unlike `2d` which assumes a flat plane.
- MongoDB will reject `$geoNear` queries on a collection without this index.

**Important:** The index is created automatically when Mongoose connects to MongoDB (since `autoIndex: true` is the Mongoose default in development). This requires no migration script for this project.

---

## 5. Shop Verification Model

Verification is simple — two fields on the Shop document:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `isVerified` | Boolean | `false` | Controls customer visibility |
| `verifiedAt` | Date | null | Audit timestamp |
| `verifiedBy` | ObjectId (User) | null | Which admin verified it |

**Verification flow:**
1. Seller creates shop → `isVerified: false`.
2. Admin reviews and calls `PATCH /api/v1/admin/shops/:id/verify`.
3. Controller sets `isVerified: true`, `verifiedAt: Date.now()`, `verifiedBy: req.user._id`.
4. Customers can now discover the shop.

**Rejection:** For this phase, admin simply does not verify. No explicit rejection status needed yet.

---

## 6. Ownership & Security Rules

All three roles have distinct capabilities enforced at the **middleware + controller** level.

### Seller rules
- Can only create a shop if they have `role: 'seller'`.
- Can only create **one** shop (enforced by checking `Shop.findOne({ owner: req.user._id })`).
- Can only update/view **their own** shop.
- Ownership check pattern (in controller, not middleware):
  ```
  const shop = await Shop.findById(req.params.id);
  if (!shop) → 404
  if (shop.owner.toString() !== req.user._id.toString()) → 403
  ```
- Cannot change `isVerified`, `verifiedAt`, or `verifiedBy` — these fields are stripped before update.

### Admin rules
- Can view all shops regardless of verification status.
- Can verify a shop.
- Cannot create or delete shops in this phase.

### Customer rules
- Can only see **verified** shops (`isVerified: true`).
- Can search nearby shops.
- Cannot create, update, or delete shops.

### Forbidden field stripping
Before any seller update, the controller removes these fields from `req.body`:
```
isVerified, verifiedAt, verifiedBy, owner
```
This prevents privilege escalation even if the request contains them.

---

## 7. API Endpoints

All routes are under `/api/v1`.

### Seller Routes — `/api/v1/seller/shops`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/seller/shops` | `protect`, `authorize('seller')` | Create shop |
| `GET` | `/api/v1/seller/shops/me` | `protect`, `authorize('seller')` | Get own shop |
| `PUT` | `/api/v1/seller/shops/me` | `protect`, `authorize('seller')` | Update own shop |

**Why `/seller/shops/me` instead of `/seller/shops/:id`?**
- A seller has exactly one shop. They don't need to specify an ID — they can only ever edit their own.
- Cleaner, simpler, and eliminates ownership-checking risk of "can seller A edit seller B's shop if they guess the ID?". The answer is never yes, but `/me` makes it structurally impossible.

### Customer Routes — `/api/v1/shops`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/shops` | Public | List all verified shops |
| `GET` | `/api/v1/shops/nearby` | Public | Find nearby verified shops |
| `GET` | `/api/v1/shops/:id` | Public | Get a single verified shop |

### Admin Routes — `/api/v1/admin/shops` (appended to existing admin router)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/admin/shops` | `protect`, `authorize('admin')` | List all shops (verified + unverified) |
| `GET` | `/api/v1/admin/shops/:id` | `protect`, `authorize('admin')` | Get any shop by ID |
| `PATCH` | `/api/v1/admin/shops/:id/verify` | `protect`, `authorize('admin')` | Verify a shop |

---

## 8. Controller & Service Responsibilities

### Pattern decision: **No service layer for Phase 2**

Looking at Phase 1, services/ is empty (only `.gitkeep`). Auth logic lives entirely in the controller. This is appropriate for a beginner-friendly project. Phase 2 will follow the same pattern — **all logic in controllers, no service files**.

The exception is the nearby-shop query (§9) which is complex enough to extract as a single helper function inside the controller file for readability.

### `shop.controller.js` — responsibilities

| Function | HTTP | Responsibility |
|----------|------|----------------|
| `createShop` | POST | Validate seller has no existing shop → create with `owner: req.user._id` |
| `getMyShop` | GET | `Shop.findOne({ owner: req.user._id })` |
| `updateMyShop` | PUT | Find own shop → strip forbidden fields → update |
| `getShops` | GET | `Shop.find({ isVerified: true })` with optional filters |
| `getShopById` | GET | `Shop.findOne({ _id: id, isVerified: true })` |
| `getNearbyShops` | GET | `$geoNear` aggregation (see §9) |
| `adminGetAllShops` | GET | `Shop.find({})` — no verification filter |
| `adminGetShopById` | GET | `Shop.findById(id)` |
| `adminVerifyShop` | PATCH | Set `isVerified`, `verifiedAt`, `verifiedBy` |

### `admin.controller.js` — responsibilities
Admin shop functions can live in a new `shop.controller.js` and be imported into the admin routes. This keeps all shop logic co-located.

---

## 9. Nearby-Shop Query Using `$geoNear`

The `/api/v1/shops/nearby` endpoint uses MongoDB's **aggregation pipeline** with `$geoNear` as the first stage.

**Query parameters accepted:**
```
GET /api/v1/shops/nearby?lat=28.6139&lng=77.2090&radius=5000
```
- `lat`: User's latitude (required)
- `lng`: User's longitude (required)
- `radius`: Search radius in **meters** (optional, default: 5000m = 5km)

**Aggregation pipeline structure:**

```
[
  {
    $geoNear: {
      near: { type: 'Point', coordinates: [lng, lat] },
      distanceField: 'distance',        // adds 'distance' field (in meters) to each result
      maxDistance: radius,              // in meters
      query: { isVerified: true },      // only show verified shops
      spherical: true                   // required for 2dsphere index
    }
  }
]
```

**Result shape per shop (after aggregation):**
```json
{
  "_id": "...",
  "name": "Sharma Electronics",
  "address": "Lajpat Nagar, Delhi",
  "isOpen": true,
  "isVerified": true,
  "location": { "type": "Point", "coordinates": [77.2090, 28.6139] },
  "distance": 432.7
}
```
`distance` is in **meters**. The controller converts it to a human-readable format (e.g., `"0.43 km"` or `"432 m"`) before sending the response.

**Why `$geoNear` via aggregation instead of `$near` on `find()`?**
- `$geoNear` is the only stage that adds a `distance` field to each result. `$near` cannot do this.
- Customers need to see distance, so `$geoNear` is the right tool.
- `$geoNear` must be the **first stage** in the pipeline — this is a MongoDB requirement.

---

## 10. Distance Handling

- MongoDB returns distance in **meters** as a float (e.g., `432.71829`).
- A small helper function (not a separate file — just a local function in `shop.controller.js`) converts it:

```
formatDistance(meters):
  if meters < 1000: return "432 m"
  else: return "0.43 km"  (rounded to 2 decimal places)
```

- This formatted string is returned in the API response alongside the raw meters value.
- The raw `distance` in meters is also returned so future frontend maps can use it programmatically.

---

## 11. Validation Requirements

**File:** `server/src/validators/shop.validators.js`

Uses the same `express-validator` pattern as `auth.validators.js`.

### `createShopRules` / `updateShopRules`

| Field | Rule |
|-------|------|
| `name` | required (for create), string, trim, max 100 chars |
| `description` | optional, string, trim, max 500 chars |
| `address` | required (for create), string, trim, max 300 chars |
| `phone` | optional, string, trim, matches phone regex |
| `location.coordinates` | required (for create), array of exactly 2 numbers |
| `location.coordinates[0]` | longitude: number between –180 and 180 |
| `location.coordinates[1]` | latitude: number between –90 and 90 |
| `isOpen` | optional, boolean |

`updateShopRules` uses `.optional()` on all fields — partial updates are valid.

### `nearbyQueryRules`

| Field | Rule |
|-------|------|
| `lat` | required, numeric, between –90 and 90 |
| `lng` | required, numeric, between –180 and 180 |
| `radius` | optional, numeric, integer, between 100m and 50,000m |

---

## 12. Error Handling

All errors follow the existing `{ success: false, message: '...' }` pattern via `asyncHandler` + centralized `errorHandler` middleware. No new error infrastructure needed.

### Shop-specific errors

| Scenario | Status Code | Message |
|----------|-------------|---------|
| Seller already has a shop | 409 | `"You already have a shop. A seller can only have one shop."` |
| Shop not found | 404 | `"Shop not found."` |
| Attempting to access another seller's shop | 403 | `"You are not authorized to modify this shop."` |
| Missing lat/lng for nearby query | 400 | (caught by validator) |
| Coordinates out of valid range | 400 | (caught by validator) |
| Verifying an already-verified shop | 400 | `"This shop is already verified."` |
| MongoDB duplicate key on owner field | 409 | Caught in errorHandler — `err.code === 11000` check already needs to exist |

### Mongoose duplicate key handling

The existing `errorHandler.js` should handle `err.code === 11000` (MongoDB duplicate key error) with a clean message. Check if this already exists; if not, add it in Phase 2 as a modification to `errorHandler.js`.

---

## 13. Required Packages

**No new packages are required.**

All needed tools already exist:
- `mongoose` — Shop model + 2dsphere index + aggregation
- `express-validator` — Validation rules
- `express` — Routing
- `jsonwebtoken` + `cookie-parser` — Auth (already working)

MongoDB's `$geoNear` is a built-in aggregation stage — no external geolocation library needed.

> ⚠️ Do NOT install `mongoose-geojson-schema`, `turf`, `geolib`, or any other geospatial npm package. Vanilla Mongoose + MongoDB handles everything.

---

## 14. Exact Files to Create / Modify

### NEW files

| File | Purpose |
|------|---------|
| `server/src/models/Shop.model.js` | Shop schema + 2dsphere index |
| `server/src/controllers/shop.controller.js` | All shop logic (seller + customer + admin functions) |
| `server/src/routes/shop.routes.js` | Seller-facing routes (`/api/v1/seller/shops`) |
| `server/src/routes/customer.routes.js` | Customer-facing routes (`/api/v1/shops`) |
| `server/src/validators/shop.validators.js` | express-validator rule chains for shops |

### MODIFIED files

| File | Change |
|------|--------|
| `server/server.js` | Mount 2 new route files: `/api/v1/seller/shops` and `/api/v1/shops` |
| `server/src/routes/admin.routes.js` | Add 3 new admin shop routes |
| `server/src/middlewares/errorHandler.js` | Add `err.code === 11000` duplicate key handling if not already present |

### NOT modified

| File | Reason |
|------|--------|
| `server/src/models/User.model.js` | No shop reference needed on User |
| `server/src/middlewares/auth.middleware.js` | `protect` and `authorize` already support this phase |
| `server/src/middlewares/validate.middleware.js` | Already generic, reusable |
| `server/src/controllers/auth.controller.js` | No changes needed |
| All `client/` files | Out of scope |

---

## 15. Testing Plan

### What Antigravity implements and tests automatically

1. **Shop creation** — POST with valid seller token → 201 + shop document
2. **Duplicate shop guard** — POST again as same seller → 409
3. **Role guard: customer cannot create shop** — POST with customer token → 403
4. **Get own shop** — GET `/seller/shops/me` → correct shop returned
5. **Update own shop** — PUT with partial fields → only those fields change
6. **Forbidden field strip** — PUT with `isVerified: true` in body → field ignored
7. **Get all verified shops (customer)** — GET `/shops` → only `isVerified: true` shops
8. **Get shop by ID (customer)** — GET `/shops/:id` → correct single shop
9. **Unverified shop hidden from customer** — GET `/shops/:id` on unverified → 404
10. **Admin get all shops** — GET `/admin/shops` → includes unverified
11. **Admin verify shop** — PATCH `/admin/shops/:id/verify` → `isVerified: true`
12. **Nearby shops** — GET `/shops/nearby?lat=X&lng=Y&radius=Z` → sorted by distance with `distance` field
13. **Nearby shops: only verified** — Unverified shop within radius → not in results
14. **Validation errors** — Missing required fields → 400 with field-level error messages
15. **Invalid coordinates** — Out-of-range lat/lng → 400

### What can be tested manually

1. **MongoDB index creation** — After first server start, open MongoDB Compass and confirm `location_2dsphere` index exists on the `shops` collection.
2. **Real-world nearby search** — Use actual coordinates from Google Maps to create a shop and verify the nearby endpoint returns it with a sensible distance.
3. **Cookie-based auth** — Use a browser (or Postman with cookie support) to verify that protected routes reject requests without a valid cookie.

---

## 16. Common Beginner Mistakes

### 🔴 Coordinates order: lat/lng vs lng/lat

**GeoJSON is `[longitude, latitude]` — this is the opposite of what most people expect.**

Wrong: `coordinates: [28.6139, 77.2090]`  
Right: `coordinates: [77.2090, 28.6139]`

If you store them backwards, the shop will appear in the ocean near West Africa instead of Delhi. The nearby query will return 0 results even if the coordinates look numerically close. This is the single most common geolocation bug.

### 🔴 Forgetting `spherical: true` in `$geoNear`

Without this, MongoDB falls back to flat-plane calculation and gives wrong distances.

### 🔴 Missing the 2dsphere index

Without the index, `$geoNear` throws: `"unable to find index for $geoNear query"`. The index must exist before any geospatial query runs.

### 🔴 Comparing ObjectIds as strings without `.toString()`

```js
// WRONG — always false even when IDs match
if (shop.owner !== req.user._id)

// CORRECT
if (shop.owner.toString() !== req.user._id.toString())
```

### 🔴 Not stripping protected fields on update

If the controller does `Shop.findByIdAndUpdate(id, req.body)` without stripping `isVerified`, a seller could self-verify their shop by sending `{ "isVerified": true }` in the PUT body.

### 🔴 Using `findByIdAndUpdate` with `req.body` directly

Always destructure only the allowed fields from `req.body` before passing to the update operation. Never spread the entire body.

### 🔴 `$geoNear` not being the first aggregation stage

MongoDB requires `$geoNear` to be the **first stage** in a pipeline. Adding a `$match` before it will throw an error.

### 🔴 Radius in wrong unit

`maxDistance` in `$geoNear` is always in **meters**. If a user sends `radius=5` expecting km, the search will only cover 5 meters. Document units clearly in the API.

### 🔴 Querying `Shop.find({ isVerified: true })` but forgetting to filter in aggregation

When using `$geoNear`, the filter must be inside the `query` field of the `$geoNear` stage — not in a separate `$match` before it (which would fail). A `$match` **after** `$geoNear` is fine.

---

## 17. Antigravity vs Manual Testing Split

### Antigravity implements and verifies
- All 15 automated test cases listed in §15
- Schema correctness (field types, defaults, indexes declared in code)
- Route mounting in server.js
- Controller logic
- Validation rules
- Error messages and status codes

### You verify manually
- MongoDB index actually created in Compass/Atlas UI
- Real GPS coordinates produce sensible results
- Cookie authentication flow in Postman (stateful session)
- Server starts without errors after all new files are added

---

## Architecture Diagram

```
server/
├── server.js                          [MODIFIED] mount /api/v1/shops, /api/v1/seller/shops
└── src/
    ├── models/
    │   ├── User.model.js              [UNCHANGED]
    │   └── Shop.model.js              [NEW] ← core of this phase
    ├── controllers/
    │   ├── auth.controller.js         [UNCHANGED]
    │   ├── user.controller.js         [UNCHANGED]
    │   ├── health.controller.js       [UNCHANGED]
    │   └── shop.controller.js         [NEW] ← all shop + nearby logic
    ├── routes/
    │   ├── auth.routes.js             [UNCHANGED]
    │   ├── health.routes.js           [UNCHANGED]
    │   ├── admin.routes.js            [MODIFIED] add 3 admin shop routes
    │   ├── shop.routes.js             [NEW] seller-facing
    │   └── customer.routes.js         [NEW] customer-facing + nearby
    ├── validators/
    │   ├── auth.validators.js         [UNCHANGED]
    │   └── shop.validators.js         [NEW]
    └── middlewares/
        ├── auth.middleware.js         [UNCHANGED]
        ├── validate.middleware.js     [UNCHANGED]
        └── errorHandler.js            [MODIFIED] add duplicate key (11000) handler
```

---

## Summary Table

| # | Topic | Decision |
|---|-------|---------|
| 1 | Schema | `Shop.model.js` with owner, name, address, phone, location (GeoJSON), isOpen, isVerified, timestamps |
| 2 | Relationship | One-to-one via `owner` on Shop; User unchanged |
| 3 | GeoJSON | `{ type: 'Point', coordinates: [lng, lat] }` |
| 4 | Index | `shopSchema.index({ location: '2dsphere' })` |
| 5 | Verification | `isVerified`, `verifiedAt`, `verifiedBy` on Shop |
| 6 | Security | Ownership checked via `shop.owner.toString() === req.user._id.toString()` |
| 7 | Endpoints | 3 seller + 3 customer + 3 admin = 9 total |
| 8 | Architecture | All logic in `shop.controller.js`; no service layer |
| 9 | Nearby query | `$geoNear` aggregation with `distanceField`, `maxDistance`, `spherical: true` |
| 10 | Distance | Raw meters + formatted string returned in response |
| 11 | Validation | `shop.validators.js` using express-validator |
| 12 | Errors | asyncHandler + centralized errorHandler; 11000 duplicate key added |
| 13 | Packages | **None new required** |
| 14 | Files | 5 new, 3 modified |
| 15 | Testing | 15 automated + 4 manual |
| 16 | Gotchas | lng/lat order, spherical, index, ObjectId comparison, field stripping |
| 17 | Split | Antigravity: all code + automated tests; Manual: Compass, GPS, Postman |
