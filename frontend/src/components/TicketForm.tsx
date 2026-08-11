import { FileText } from "lucide-react"
import { useState, useRef } from "react";
import API_BASE from "../lib/api";
import { Department, TicketCategory, Client, PAGES, SubDepartment } from "../types";
import AttachmentUploader from "./AttachmentUploader";
import { uploadAttachmentToS3 } from "../libs/attachmentUpload";
import { DateTimePicker } from "./DateTimePicker";
import { CyprusAssistant, CyprusAssistantHandle } from "./CyprusAssistant";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
  "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim",
  "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
];

const UNION_TERRITORIES: { value: string; label: string }[] = [
  { value: "Andaman and Nicobar Islands", label: "Andaman & Nicobar Islands" },
  { value: "Chandigarh", label: "Chandigarh" },
  { value: "Dadra and Nagar Haveli and Daman and Diu", label: "Dadra & Nagar Haveli & Daman & Diu" },
  { value: "Delhi", label: "Delhi" },
  { value: "Jammu and Kashmir", label: "Jammu & Kashmir" },
  { value: "Ladakh", label: "Ladakh" },
  { value: "Lakshadweep", label: "Lakshadweep" },
  { value: "Puducherry", label: "Puducherry" },
];

const DESIGNATIONS = ["CEO", "COO", "CXO", "HOD", "EMPLOYEE"];

// Section heading used to separate the form into the field groups the
// person fills in, in order: client details -> location -> routing ->
// issue details -> attachments.
const SectionHeading = ({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ElementType;
  title: string;
  subtitle?: string;
}) => (
  <div className="flex items-center gap-2 mb-1">
    <Icon size={14} className="text-indigo-600 shrink-0" />
    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">{title}</h2>
    {subtitle && <span className="text-[11px] text-slate-400 font-normal normal-case">- {subtitle}</span>}
  </div>
);

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-xs font-semibold text-slate-700 mb-1">{children}</label>
);

const textInputClass =
  "w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all";

export const TicketForm = ({setError,setSuccess,setSelectedTicketId,setCurrentView,token,departments,clients}:{
    setError:React.Dispatch<React.SetStateAction<string>>,
    setSuccess:React.Dispatch<React.SetStateAction<string>>,
    setSelectedTicketId: (id: string) => void,
    setCurrentView: (view: string) => void,
    token:string,
    departments:Department[],
    clients:Client[]
}) => {
  const [newTicketTitle, setNewTicketTitle] = useState("");
  const [newTicketDesc, setNewTicketDesc] = useState("");
  const cyprusRef = useRef<CyprusAssistantHandle>(null);
  const [newTicketDept, setNewTicketDept] = useState("");
  const [newTicketCategory, setNewTicketCategory] = useState("");
  const [newTicketClient, setNewTicketClient] = useState("");
  const [newTicketClientEmail, setNewTicketClientEmail] = useState("");
  const [newTicketClientRep, setNewTicketClientRep] = useState("");
  const [newTicketClientEmpId, setNewTicketClientEmpId] = useState("");
  const [newTicketSite, setNewTicketSite] = useState("");
  const [newTicketState, setNewTicketState] = useState("");
  const [newTicketDesignation, setNewTicketDesignation] = useState("");
  const [newTicketProjectId, setNewTicketProjectId] = useState("");
  const [newTicketIsShutdownJob, setNewTicketIsShutdownJob] = useState(false);
  const [newTicketDateOccurred, setNewTicketDateOccurred] = useState("");
  const [newTicketTags, setNewTicketTags] = useState<string>("");
  const [newTicketAttachFiles, setNewTicketAttachFiles] = useState<File[]>([]);
  const [attachmentUploadError, setAttachmentUploadError] = useState("");
  const [deptCategories, setDeptCategories] = useState<TicketCategory[]>([]);
  const [deptSubDepartments, setDeptSubDepartments] = useState<SubDepartment[]>([]);
  const [newTicketSubDepartment, setNewTicketSubDepartment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // NOTE(added): Project is only mandatory when the chosen client actually
  // has projects to pick from - some clients have none, and there's no
  // sensible option to force in that case.
  const selectedClientProjects = Array.isArray(clients) ? (clients.find(c => c.name === newTicketClient)?.projects ?? []) : [];
  const isProjectRequired = selectedClientProjects.length > 0;



// Handles department select when submitting ticket to trigger category
// (and sub-department) fetching. Sub-department is optional: until the
// user picks one, the category dropdown lists every category under the
// department.
  const handleTicketDeptChange = async (deptId: string) => {
    setNewTicketDept(deptId);
    setNewTicketCategory("");
    setNewTicketSubDepartment("");
    if (!deptId || deptId === "OTHER") {
      setDeptCategories([]);
      setDeptSubDepartments([]);
      return;
    }
    try {
      const [catRes, subDeptRes] = await Promise.all([
        fetch(`${API_BASE}/departments/${deptId}/categories`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        fetch(`${API_BASE}/departments/${deptId}/subdepartments`, {
          headers: { Authorization: `Bearer ${token}` }
        })
      ]);
      if (catRes.ok) setDeptCategories(await catRes.json());
      if (subDeptRes.ok) setDeptSubDepartments(await subDeptRes.json());
    } catch (err) {}
  };

  // Handles sub-department select - re-fetches categories scoped to just
  // that sub-department. Clearing the sub-department (back to "-- All --")
  // goes back to showing every category in the department.
  const handleTicketSubDepartmentChange = async (subDepartmentId: string) => {
    setNewTicketSubDepartment(subDepartmentId);
    setNewTicketCategory("");
    if (!newTicketDept || newTicketDept === "OTHER") return;
    try {
      const url = subDepartmentId
        ? `${API_BASE}/departments/${newTicketDept}/categories?subDepartmentId=${subDepartmentId}`
        : `${API_BASE}/departments/${newTicketDept}/categories`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setDeptCategories(await res.json());
    } catch (err) {}
  };



    const handleSubmitTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return; // already submitting - ignore extra clicks/submits
    setError("");
    setSuccess("");
    if (!newTicketDept || !newTicketTitle || !newTicketClient || !newTicketSite || !newTicketDesc || !newTicketState || !newTicketDesignation || !newTicketDateOccurred || (isProjectRequired && !newTicketProjectId)) {
      setError("Please fill out all required fields.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/tickets`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          departmentId: newTicketDept === "OTHER" ? "dept-other" : newTicketDept,
          departmentName: newTicketDept === "OTHER" ? "Other" : undefined,
          categoryId: newTicketCategory === "OTHER" ? "cat-other" : (newTicketCategory || null),
          categoryName: newTicketCategory === "OTHER" ? "Other" : undefined,
          title: newTicketTitle,
          description: newTicketDesc,
          clientName: newTicketClient,
          clientEmail: newTicketClientEmail.trim() || undefined,
          representative: newTicketClientRep,
          employeeId: newTicketClientEmpId ,
          dateOfOccurance: new Date(newTicketDateOccurred).toISOString(),
          site: newTicketSite,
          state: newTicketState,
          designation: newTicketDesignation,
          projectId: newTicketProjectId || undefined,
          isShutdownJob: newTicketIsShutdownJob,
          tags: [] 
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit ticket");

      // Upload any staged attachments straight to S3 now that the ticket has an id
      if (newTicketAttachFiles.length > 0) {
        setAttachmentUploadError("");
        const results = await Promise.allSettled(
          newTicketAttachFiles.map((file) => uploadAttachmentToS3(file, data.id, token))
        );
        const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        if (failed.length > 0) {
          setAttachmentUploadError(
            `Ticket ${data.ticketNumber || data.id} was created, but ${failed.length} attachment(s) failed to upload. You can add them from the ticket detail page.`
          );
        }
      }

      // Reset
      setNewTicketTitle("");
      setNewTicketDesc("");
      setNewTicketDept("");
      setNewTicketCategory("");
      setNewTicketSubDepartment("");
      setDeptSubDepartments([]);
      setNewTicketClient("");
      setNewTicketClientEmail("");
      setNewTicketClientRep("");
      setNewTicketClientEmpId("");
      setNewTicketSite("");
      setNewTicketState("");
      setNewTicketDesignation("");
      setNewTicketProjectId("");
      setNewTicketIsShutdownJob(false);
      setNewTicketDateOccurred("");
      setNewTicketTags("");
      setNewTicketAttachFiles([]);

      // Navigate to detailed ticket view directly
      setSelectedTicketId(data.id);
      setCurrentView(PAGES.TICKET_DETAILS);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };


    return (
        <div className="max-w-3xl mx-auto space-y-6 font-sans">
              <div className="bg-white border border-slate-200/80 p-6 rounded-2xl shadow-xs">
                <h1 className="text-lg font-bold text-slate-900 border-b border-slate-100 pb-3 flex items-center gap-2">
                  <FileText className="text-indigo-600" size={20} />
                  New Customer Pulse Ticket
                </h1>
                <p className="text-xs text-slate-500 mt-2">
                  Complete corporate details. Priority assignments are computed automatically on routing based on client account definitions and service parameters.
                </p>
              </div>

              <form onSubmit={handleSubmitTicket} className="bg-white border border-slate-200/80 rounded-2xl p-8 space-y-5 shadow-sm">

                <div className="border-t border-slate-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Client / Company Name *</label>
                    <select
                      value={newTicketClient}
                      onChange={(e) => {
                        setNewTicketClient(e.target.value);
                        setNewTicketProjectId("");
                      }}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                      required
                    >
                      <option value="">-- Choose Client --</option>
                      {Array.isArray(clients) && clients.map(c => (
                        <option key={c.id} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Project{isProjectRequired ? " *" : ""}</label>
                    <select
                      value={newTicketProjectId}
                      onChange={(e) => setNewTicketProjectId(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer disabled:bg-slate-50 disabled:cursor-not-allowed"
                      disabled={!newTicketClient}
                      required={isProjectRequired}
                    >
                      <option value="">-- Choose Project --</option>
                      {selectedClientProjects.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Client Email</label>
              <input
                type="email"
                placeholder="authorized@client.com"
                value={newTicketClientEmail}
                onChange={(e) => setNewTicketClientEmail(e.target.value)}
                className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Client Designation *</label>
              <select
                value={newTicketDesignation}
                onChange={(e) => setNewTicketDesignation(e.target.value)}
                className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                required
              >
                <option value="">-- Choose Designation --</option>
                <option value="CEO">CEO</option>
                <option value="COO">COO</option>
                <option value="CXO">CXO</option>
                <option value="HOD">HOD</option>
                <option value="EMPLOYEE">EMPLOYEE</option>
              </select>
            </div>
          </div>

<div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Site / Physical location *</label>
                    <input
                      type="text"
                      placeholder="e.g. John Doe"
                      value={newTicketSite}
                      onChange={(e) => setNewTicketSite(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">State *</label>
                    <select
                      value={newTicketState}
                      onChange={(e) => setNewTicketState(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                      required
                    >
                      <option value="">-- Choose Indian State --</option>
                      <option value="Andhra Pradesh">Andhra Pradesh</option>
                      <option value="Arunachal Pradesh">Arunachal Pradesh</option>
                      <option value="Assam">Assam</option>
                      <option value="Bihar">Bihar</option>
                      <option value="Chhattisgarh">Chhattisgarh</option>
                      <option value="Goa">Goa</option>
                      <option value="Gujarat">Gujarat</option>
                      <option value="Haryana">Haryana</option>
                      <option value="Himachal Pradesh">Himachal Pradesh</option>
                      <option value="Jharkhand">Jharkhand</option>
                      <option value="Karnataka">Karnataka</option>
                      <option value="Kerala">Kerala</option>
                      <option value="Madhya Pradesh">Madhya Pradesh</option>
                      <option value="Maharashtra">Maharashtra</option>
                      <option value="Manipur">Manipur</option>
                      <option value="Meghalaya">Meghalaya</option>
                      <option value="Mizoram">Mizoram</option>
                      <option value="Nagaland">Nagaland</option>
                      <option value="Odisha">Odisha</option>
                      <option value="Punjab">Punjab</option>
                      <option value="Rajasthan">Rajasthan</option>
                      <option value="Sikkim">Sikkim</option>
                      <option value="Tamil Nadu">Tamil Nadu</option>
                      <option value="Telangana">Telangana</option>
                      <option value="Tripura">Tripura</option>
                      <option value="Uttar Pradesh">Uttar Pradesh</option>
                      <option value="Uttarakhand">Uttarakhand</option>
                      <option value="West Bengal">West Bengal</option>
                      <option value="Andaman and Nicobar Islands">Andaman & Nicobar Islands</option>
                      <option value="Chandigarh">Chandigarh</option>
                      <option value="Dadra and Nagar Haveli and Daman and Diu">Dadra & Nagar Haveli & Daman & Diu</option>
                      <option value="Delhi">Delhi</option>
                      <option value="Jammu and Kashmir">Jammu & Kashmir</option>
                      <option value="Ladakh">Ladakh</option>
                      <option value="Lakshadweep">Lakshadweep</option>
                      <option value="Puducherry">Puducherry</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5">
                  <input
                    id="newTicketIsShutdownJob"
                    type="checkbox"
                    checked={newTicketIsShutdownJob}
                    onChange={(e) => setNewTicketIsShutdownJob(e.target.checked)}
                    className="rounded"
                  />
                  <label htmlFor="newTicketIsShutdownJob" className="text-xs font-medium text-slate-700 cursor-pointer select-none">
                    This ticket is related to a shutdown job
                  </label>
                </div>


                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Department *</label>
                    <select
                      value={newTicketDept}
                      onChange={(e) => handleTicketDeptChange(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                      required>
                      <option value="">-- Select Department --</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                      
                        <option value="OTHER">Other</option>
                    </select>
                  </div>

                  
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">Sub-Department</label>
                      <select
                        value={newTicketSubDepartment}
                        onChange={(e) => handleTicketSubDepartmentChange(e.target.value)}
                        className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                      >
                        <option value="">-- All / Not applicable --</option>
                        {deptSubDepartments.map(sd => (
                          <option key={sd.id} value={sd.id}>{sd.name}</option>
                        ))}
                      </select>
                    </div>
                  

                  
                </div>

                

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Issue *</label>
                    <select
                      value={newTicketCategory}
                      onChange={(e) => setNewTicketCategory(e.target.value)}
                      className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer"
                      disabled={!newTicketDept}
                    >
                      <option value="">-- Select Category --</option>
                      {deptCategories.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                      {newTicketDept && <option value="OTHER">Other</option>}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">Issue Occurred (Date & Time) *</label>
                    <DateTimePicker
                      value={newTicketDateOccurred}
                      onChange={setNewTicketDateOccurred}
                      maxDate={new Date()}
                    />
                  </div>
                </div>


                

                <div className="border-t border-slate-100 pt-4">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Title *</label>
                  <input
                    type="text"
                    placeholder="Short summary of the outage or issue"
                    value={newTicketTitle}
                    onChange={(e) => setNewTicketTitle(e.target.value)}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-semibold"
                    required
                  />
                </div>

                <div className="relative">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Description *</label>
                  <CyprusAssistant
                    ref={cyprusRef}
                    description={newTicketDesc}
                    title={newTicketTitle}
                    token={token}
                    onSelect={(text) => setNewTicketDesc(text)}
                    onTitleSelect={(t) => setNewTicketTitle(t)}
                  />
                  <textarea
                    placeholder="Provide troubleshooting details, steps to reproduce, or notes."
                    value={newTicketDesc}
                    onChange={(e) => setNewTicketDesc(e.target.value)}
                    onKeyDown={(e) => {
                      // Ctrl+/ — Cyprus magic-polish: rewrite the description
                      // straight into this box, no panel.
                      if (e.ctrlKey && e.key === "/") {
                        e.preventDefault();
                        cyprusRef.current?.polishDirect();
                      }
                    }}
                    className="w-full text-xs p-2.5 border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                    rows={4}
                    required
                  />
                </div>

               

                <div className="pt-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Attachments (Optional)</label>
                  <AttachmentUploader
                    token={token}
                    stagedFiles={newTicketAttachFiles}
                    onStagedFilesChange={setNewTicketAttachFiles}
                  />
                  {attachmentUploadError && (
                    <p className="mt-2 text-[11px] text-amber-600">{attachmentUploadError}</p>
                  )}
                </div>

                <div className="border-t border-slate-100 pt-4 flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setCurrentView(PAGES.DASHBOARD)}
                    className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-2 bg-red-600 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? "Creating..." : "Submit"}
                  </button>
                </div>
              </form>
            </div>
    )
}


