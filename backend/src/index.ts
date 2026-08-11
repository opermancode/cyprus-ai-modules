import "dotenv/config";
import express from "express";
import { authRouter } from "./routes/auth";
import { invitationRouter } from "./routes/invitations";
import { ticketRouter } from "./routes/tickets";
import { keywordRouter } from "./routes/keywords";
import { departmentRouter } from "./routes/departments";
import { categoryRouter } from "./routes/categories";
import { subDepartmentRouter } from "./routes/subDepartments";
import { userRouter } from "./routes/users";
import { auditLogRouter } from "./routes/auditLogs";
import { startScheduledJobs } from "./job/scheduler";
import { securityHeaders, corsMiddleware } from "./middleware/security";
import { generalLimiter } from "./middleware/rateLimiter";
import { requestLogger } from "./middleware/requestLogger";
import { requestContextMiddleware } from "./lib/requestContext";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler";
import { clientRouter } from "./routes/client";
import { projectRouter } from "./routes/project";
import { managerDashboardRouter } from "./routes/managerDashboard";
import { requestorRouter } from "./routes/requestors";

import { cxoRouter } from "./routes/cxoDashboard";
import { agentDashboardRouter } from "./routes/agentDashboard";
import { uploadsRouter } from "./routes/uploads";
import { adminTicketRouter } from "./routes/adminTickets";
import { settingsRouter } from "./routes/settings";
import { cyprusRouter } from "./routes/cyprus";
import cors from "cors"

const app = express();

// ---- global middleware, in order ----
app.use(securityHeaders);
app.use(corsMiddleware);
// Mounted before express.json() so raw file bytes PUT here aren't parsed as JSON.
// Temporary local-storage stand-in for direct-to-S3 uploads (see lib/s3.ts).
app.use(cors({origin:"https://customerpulse.sanghvimovers.com"}));
app.use("/uploads", uploadsRouter);
app.use(express.json());
app.set("trust proxy", 1);
// Opens the per-request AsyncLocalStorage context (IP, later the resolved
// user) that the file-based activity logs key off - see
// middleware/requestContext.ts and lib/database.ts.
app.use(requestContextMiddleware);
app.use(requestLogger);

// app.use(generalLimiter);
// ---- routes ----
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRouter);
app.use("/departments", departmentRouter);
app.use("/categories", categoryRouter);
app.use("/subdepartments", subDepartmentRouter);
app.use("/users", userRouter);
app.use("/invitations", invitationRouter);
app.use("/tickets", ticketRouter);
app.use("/keywords", keywordRouter);
app.use("/audit-logs", auditLogRouter);
app.use("/clients",clientRouter)
app.use("/projects",projectRouter)
app.use("/manager-dashboard",managerDashboardRouter)
app.use("/admin/requestors", requestorRouter)

app.use("/cxo-dashboard",cxoRouter)
app.use("/agent-dashboard", agentDashboardRouter)
app.use("/admin-tickets", adminTicketRouter)
app.use("/settings", settingsRouter)
app.use("/ai", cyprusRouter)
// ---- must be last ----
app.use(notFoundHandler);
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
    startScheduledJobs()
    console.log(`Helpdesk API listening on :${port}`);
});


