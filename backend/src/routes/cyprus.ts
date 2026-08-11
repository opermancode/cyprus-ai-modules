import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { cyprusLimiter } from "../middleware/rateLimiter";
import { cyprusRefineSchema } from "../utils/schemas";
import { cyprusController } from "../controllers/cyprus.controller";

// Cyprus AI assistant - mounted at /ai in index.ts.
// (In prod, nginx forwards /api/ai/* here via the /api prefix rewrite.)
export const cyprusRouter = Router();

cyprusRouter.post(
  "/cyprus/refine",
  requireAuth,
  cyprusLimiter,
  validateBody(cyprusRefineSchema),
  asyncHandler(cyprusController.refineDescription)
);
