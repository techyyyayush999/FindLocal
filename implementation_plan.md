# Phase 0: Backend Foundation Setup for FindLocal

Initialize a clean, modular Express.js backend for FindLocal inside `server/` with MongoDB/Mongoose connection, environment configuration, centralized error handling, and a health check endpoint. The existing `client/` directory will remain completely untouched.

## Proposed Changes

### Backend Setup (`server/`)

#### [NEW] [package.json](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/package.json)
- Initialize npm project.
- Install minimal production dependencies: `express`, `mongoose`, `dotenv`, `cors`.
- Install dev dependency: `nodemon`.
- Configure scripts:
  - `"start": "node server.js"`
  - `"dev": "nodemon server.js"`

#### [NEW] [.env](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/.env) & [.env.example](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/.env.example)
- Define configuration variables:
  - `PORT=5000`
  - `NODE_ENV=development`
  - `MONGO_URI=mongodb://localhost:27017/findlocal`
  - `CORS_ORIGIN=http://localhost:5173`
- Ensure `.env` is gitignored and `.env.example` serves as a template.

#### [NEW] [.gitignore](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/.gitignore)
- Ignore `node_modules`, `.env`, and OS/editor temporary files.

#### [NEW] [src/config/db.js](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/src/config/db.js)
- Implement `connectDB()` using Mongoose to connect to `process.env.MONGO_URI`.
- Log connection status or handle connection errors cleanly without crashing unexpectedly.

#### [NEW] [src/middlewares/errorHandler.js](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/src/middlewares/errorHandler.js)
- `notFound`: Catches requests to unhandled routes and forwards a 404 error.
- `errorHandler`: Centralized error middleware returning consistent JSON responses `{ success: false, message: ... }`.

#### [NEW] [src/controllers/health.controller.js](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/src/controllers/health.controller.js) & [src/routes/health.routes.js](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/src/routes/health.routes.js)
- Controller and router for `GET /api/v1/health`.
- Returns a clean JSON success payload (e.g., status, timestamp, uptime, environment).

#### [NEW] Directory placeholders
- Create `.gitkeep` files in `src/models/`, `src/services/`, and `src/utils/` to establish the required directory architecture without unnecessary code.

#### [NEW] [server.js](file:///c:/Users/ayush/OneDrive/Desktop/FIndLocal/server/server.js)
- Server entry point:
  - Load environment variables using `dotenv`.
  - Configure `cors` with `process.env.CORS_ORIGIN` (or permissive fallback for development).
  - Parse JSON and URL-encoded request bodies.
  - Mount health check routes under `/api/v1/health`.
  - Attach 404 and centralized error-handling middlewares.
  - Establish MongoDB connection.
  - Listen on `PORT`.

## Verification Plan

### Automated / Execution Tests
1. **Dependency Installation**:
   - Run `npm install` inside `server/` and verify clean resolution.
2. **Server Launch**:
   - Start the backend using `npm run dev` or `node server.js` to ensure clean startup without syntax or runtime errors.
3. **Health Check Endpoint Verification**:
   - Make an HTTP GET request (`curl` or PowerShell `Invoke-RestMethod`) to `http://localhost:5000/api/v1/health` and verify HTTP 200 and expected JSON output:
     ```json
     {
       "success": true,
       "message": "FindLocal API is running healthy"
     }
     ```
4. **Error Handling Check**:
   - Make a GET request to an undefined route (e.g. `http://localhost:5000/api/v1/nonexistent`) to ensure the centralized error handler returns a formatted 404 JSON response.
5. **Client Integrity**:
   - Verify that `client/` has not been modified using `git status`.
