import { z } from "zod";
import { UserRole, SupportLevel, TicketStatus, TicketPriority, Designation } from "../generated/prisma/client";

// Kept close to the controllers that use them rather than one giant
// file per resource - easier to see the shape a given endpoint expects
// without cross-referencing multiple files.

// Requests a presigned S3 upload URL for a ticket attachment. fileSize is
// coerced from the client so a plain JSON number or numeric string both
// work; the 20MB ceiling is enforced here AND again server-side against
// the actual object via S3's ContentLength pin (see lib/s3.ts).
export const presignAttachmentSchema = z.object({
  fileName: z.string().min(1).max(300),
  fileType: z.string().min(1).max(150),
  fileSize: z.coerce
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024, "File exceeds the 20MB limit"),
});

export const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(UserRole),
  departmentId: z.string().uuid().optional(),
  supportLevel: z.nativeEnum(SupportLevel).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Cyprus AI assistant: refines a ticket description into two polished
// versions. The description is what the user typed; title is optional extra
// context so the rewrite can stay on-topic.
export const cyprusRefineSchema = z.object({
  description: z.string().trim().min(10, "Description is too short to refine").max(10000),
  title: z.string().trim().min(1).max(200).optional(),
});

// Forgot-password flow: request an OTP, verify it, then reset the password.
// Kept as three separate schemas/endpoints so the reset step can require a
// short-lived "verified" proof rather than trusting the OTP is still valid.
export const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

export const verifyPasswordResetOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d{6}$/, "OTP must be 6 digits"),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d{6}$/, "OTP must be 6 digits"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(32),
  fullName: z.string().min(1).max(200),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const createTicketSchema = z.object({
  // NOTE(added): OTHER_DEPARTMENT_ID/OTHER_CATEGORY_ID (ticket.service.ts)
  // are non-uuid sentinels the intake form sends for "Other" - resolved to
  // a real department/category via keyword matching in createTicket().
  departmentId: z.union([z.string().uuid(), z.literal("dept-other")]),
  categoryId: z.union([z.string().uuid(), z.literal("cat-other")]).optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  tags: z.array(z.string()).optional(),
  // Client-issue intake form fields (see prisma/schema.prisma Ticket
  // model comments for why representative/employeeId are optional).
  representative: z.string().max(200).optional(),
  employeeId: z.string().max(50).optional(),
  clientName: z.string().min(1).max(200),
  // NOTE(added): optional - not every client contact has (or wants to
  // share) an email on file. Empty string is treated the same as omitted
  // (see ticket.service.ts/ticket.controller.ts), so the intake form can
  // submit "" without tripping the .email() format check.
  clientEmail: z.union([z.string().email(), z.literal("")]).optional(),
  dateOfOccurance: z.coerce.date(),
  site: z.string().min(1).max(200),
  state: z.string().min(1).max(100),
  // NOTE(added): requester's designation at the client org, and the specific
  // project (under the selected client) the ticket relates to - both optional
  // since not every client has projects configured yet.
  designation: z.nativeEnum(Designation).optional(),
  projectId: z.string().uuid().optional(),
  // NOTE(added): captured directly on the intake form now, rather than
  // being inherited from the selected project - see Ticket model comment.
  isShutdownJob: z.boolean().optional(),
});

export const updateTicketSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(10_000).optional(),
    tags: z.array(z.string()).optional(),
    status: z.nativeEnum(TicketStatus).optional(),
    // Required only when status is being set to ON_HOLD - see refine below.
    // Recorded as both the TicketStatusHistory note and a regular ticket comment.
    comment: z.string().min(1).max(5000).optional(),
  })
  .refine(
    (data) => data.status !== TicketStatus.ON_HOLD || (data.comment && data.comment.trim().length > 0),
    { message: "A comment is required when placing a ticket on hold", path: ["comment"] }
  );

// Admin-only priority override - separate from updateTicketSchema since
// only GLOBAL_ADMIN/DEPT_ADMIN can touch this, everyone else's PATCH
// /tickets/:id never includes it.
export const updateTicketPrioritySchema = z.object({
  priority: z.nativeEnum(TicketPriority),
});

export const escalateTicketSchema = z.object({
  reason: z.string().min(1).max(2000),
  toLevel: z.nativeEnum(SupportLevel).optional(),
});

export const assignTicketSchema = z.object({
  agentId: z.string().uuid(),
});

export const createKeywordSchema = z.object({
  departmentId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  synonyms: z.array(z.string()).optional(),
});

export const promoteSuggestionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  synonyms: z.array(z.string()).optional(),
  grantToUserIds: z.array(z.string().uuid()).optional(),
});

export const updateUserSchema = z.object({
  fullName: z.string().min(1).max(200).optional(),
  role: z.nativeEnum(UserRole).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
  supportLevel: z.nativeEnum(SupportLevel).nullable().optional(),
  isActive: z.boolean().optional(),
  isAvailableForAssignment: z.boolean().optional(),
  maxActiveTickets: z.number().int().min(1).max(200).optional(),
});

export const createTicketCategorySchema = z.object({
  name: z.string().min(1).max(150),
  defaultSlaMinutes: z.number().int().positive().optional(),
  defaultPriority: z.nativeEnum(TicketPriority).optional(),
  minSupportLevel: z.nativeEnum(SupportLevel).optional(),
});

export const createCommentSchema = z.object({
  commentText: z.string().min(1).max(5000),
  isInternal: z.boolean().optional(),
});

// Client is a flat lookup list - just a name.
export const clientSchema = z.object({
  name: z.string().min(1).max(200),
});

// Lets an agent be linked to (or unlinked from) a category for
// category-first auto-assignment.
export const categoryAgentSchema = z.object({
  userId: z.string().uuid(),
  proficiency: z.number().int().min(1).max(10).optional(),
});

// POST /admin-tickets  (HOD, CXO, AGENT only) - a lightweight internal
// ticket raised directly to the GLOBAL_ADMIN. See prisma/schema.prisma
// AdminTicket model comments for why this is separate from createTicketSchema.
export const createAdminTicketSchema = z.object({
  subject: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
});

// PATCH /admin-tickets/:id  (GLOBAL_ADMIN only) - respond to / resolve an
// admin ticket. status defaults to RESOLVED when an adminResponse is given
// and no explicit status is passed, but either can be sent independently
// (e.g. moving OPEN -> IN_PROGRESS with no response yet).
export const resolveAdminTicketSchema = z.object({
  adminResponse: z.string().min(1).max(10_000).optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
}).refine(
  (data) => data.adminResponse !== undefined || data.status !== undefined,
  { message: "Provide at least a status update or a response", path: ["status"] }
);

// POST /audit-logs - lets the frontend explicitly report an action it
// took (e.g. "opened ticket detail", "downloaded attachment") that
// wouldn't otherwise generate a server-side AuditLog row on its own.
// Most audit rows are still written server-side as a side effect of the
// action itself (status changes, priority overrides, invitations) -
// this is specifically for frontend-only events with no matching mutation.
export const createAuditLogSchema = z.object({
  action: z.string().min(1).max(100),
  entityType: z.string().min(1).max(50),
  entityId: z.string().optional(),
});


