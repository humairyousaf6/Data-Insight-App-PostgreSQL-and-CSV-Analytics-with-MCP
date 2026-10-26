import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import createPlotlyComponentFactory from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import "./App.css";

type AuthResponse = {
  token: string;
  user: { id: string; email: string; fullName: string; role: string };
};

type Monitor = {
  id: string;
  name: string;
  metricName: string;
  thresholdPercent: number;
  scheduleCron: string;
  alerts?: { id: string; message: string; triggeredAt: string }[];
};

type DataConnection = {
  id: string;
  name: string;
  type: "postgres" | "mongodb" | "csv" | "excel";
  isActive: boolean;
  config: Record<string, unknown>;
};

type ReportTableRow = Record<string, unknown>;
type ChatMessage = {
  role: "user" | "assistant";
  type?: "text" | "table" | "chart" | "clarification" | "status";
  content: string;
  table?: { columns: string[]; rows: ReportTableRow[]; truncated?: boolean };
  chart?: { id: string; title: string; data: Array<Record<string, unknown>>; layout?: Record<string, unknown> };
};
type ChatSessionSummary = {
  _id?: string;
  sessionId: string;
  updatedAt?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
};
type OnboardingAnswer = { question: string; answer: string };
type MemorySnapshot = {
  businessContext: string;
  domain: string;
  primaryMetric: string;
  timeContext: { start: string; frequency: string };
  businessRules: string[];
  defaultFilters: string[];
  columnMeanings: Record<string, string>;
  suggestedQuestions: string[];
};

const createPlotlyComponent =
  typeof createPlotlyComponentFactory === "function"
    ? createPlotlyComponentFactory
    : ((createPlotlyComponentFactory as { default?: unknown }).default as (
        plotly: unknown,
      ) => unknown);
const Plot = createPlotlyComponent(Plotly as never) as ComponentType<Record<string, unknown>>;

type DashboardTab = "connections" | "sessions" | "chat" | "knowledge" | "automation";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";

async function apiCall<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch {
    throw new Error(`Cannot reach API server at ${API_BASE}.`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const text = body && typeof body.error === "string" ? body.error : null;
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.json();
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Request failed.";
}

function formatSessionUpdatedAt(value?: string) {
  if (!value) return "No activity timestamp";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "No activity timestamp";
  return parsed.toLocaleString();
}

function rowsToCsv(rows: ReportTableRow[]) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const escapeCell = (value: unknown) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
  };
  const header = columns.map(escapeCell).join(",");
  const body = rows
    .map((row) => columns.map((column) => escapeCell(row[column])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

function App() {
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem("auth_token") || null,
  );
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [submitOnEnter, setSubmitOnEnter] = useState(true);
  const [chatSessionId, setChatSessionId] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatStatuses, setChatStatuses] = useState<string[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [knowledgeQuestions, setKnowledgeQuestions] = useState<string[]>([]);
  const [knowledgeAnswers, setKnowledgeAnswers] = useState<OnboardingAnswer[]>([]);
  const [columnSuggestions, setColumnSuggestions] = useState<Record<string, string>>({});
  const [columnMeanings, setColumnMeanings] = useState<Record<string, string>>({});
  const [isKnowledgeSaving, setIsKnowledgeSaving] = useState(false);
  const [uploadInfo, setUploadInfo] = useState("");
  const [uploadSourceName, setUploadSourceName] = useState("");
  const [uploadProjectId, setUploadProjectId] = useState("");
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [newPgConnectionString, setNewPgConnectionString] = useState("");
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [monitorName, setMonitorName] = useState("");
  const [monitorMetric, setMonitorMetric] = useState("");
  const [monitorCron, setMonitorCron] = useState("0 */12 * * *");
  const [monitorThreshold, setMonitorThreshold] = useState(10);
  const [passwordCurrent, setPasswordCurrent] = useState("");
  const [passwordNew, setPasswordNew] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [activeTab, setActiveTab] = useState<DashboardTab>("connections");
  const [selectedSavedConnectionId, setSelectedSavedConnectionId] = useState("");
  const isAuthed = useMemo(() => Boolean(token), [token]);
  const activeConnection = useMemo(
    () => connections.find((connection) => connection.isActive) || null,
    [connections],
  );
  const uniqueConnections = useMemo(() => {
    const deduped = new Map<string, DataConnection>();
    for (const connection of connections) {
      const key = `${connection.name.trim().toLowerCase()}::${connection.type}`;
      const existing = deduped.get(key);
      if (!existing || (!existing.isActive && connection.isActive)) {
        deduped.set(key, connection);
      }
    }
    return Array.from(deduped.values());
  }, [connections]);

  useEffect(() => {
    if (!token) return;
    void apiCall<DataConnection[]>("/api/connections", {}, token).then(
      setConnections,
    );
  }, [token]);

  useEffect(() => {
    if (!token || !activeConnection?.id) return;
    void apiCall<{ sessions: ChatSessionSummary[] }>(
      `/api/chat/history?connectionId=${activeConnection.id}`,
      {},
      token,
    )
      .then((payload) => setChatSessions(payload.sessions || []))
      .catch(() => setChatSessions([]));
  }, [token, activeConnection?.id]);

  async function register(e: FormEvent) {
    e.preventDefault();
    try {
      const auth = await apiCall<AuthResponse>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          fullName: registerName,
          email: registerEmail,
          password: registerPassword,
        }),
      });
      setToken(auth.token);
      localStorage.setItem("auth_token", auth.token);
      setStatusMessage(`Registered as ${auth.user.fullName}.`);
      await loadConnections(auth.token);
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    try {
      const auth = await apiCall<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      setToken(auth.token);
      localStorage.setItem("auth_token", auth.token);
      setStatusMessage(`Welcome back ${auth.user.fullName}.`);
      await loadConnections(auth.token);
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function logout() {
    setToken(null);
    localStorage.removeItem("auth_token");
    setMonitors([]);
    setConnections([]);
    setStatusMessage("Logged out.");
  }

  async function loadConnections(currentToken?: string) {
    const authToken = currentToken || token;
    if (!authToken) return;
    const list = await apiCall<DataConnection[]>("/api/connections", {}, authToken);
    setConnections(list);
  }

  async function activateConnection(connectionId: string) {
    if (!token) return;
    await apiCall(`/api/connections/${connectionId}/activate`, { method: "POST" }, token);
    await loadConnections();
  }

  async function quickSwitchConnection(connectionId: string) {
    if (!connectionId || connectionId === activeConnection?.id) return;
    await activateConnection(connectionId);
    setStatusMessage("Active database switched.");
  }

  async function removeConnection(connectionId: string) {
    if (!token) return;
    await apiCall(`/api/connections/${connectionId}`, { method: "DELETE" }, token);
    await loadConnections();
  }

  async function removeSelectedConnection() {
    if (!selectedSavedConnectionId) return;
    await removeConnection(selectedSavedConnectionId);
    setSelectedSavedConnectionId("");
  }

  async function uploadFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file || !token) return;

    const formData = new FormData();
    formData.append("file", file);
    if (uploadSourceName.trim()) formData.append("sourceName", uploadSourceName.trim());
    if (uploadProjectId.trim()) formData.append("projectId", uploadProjectId.trim());
    const response = await apiCall<{
      datasetId: string;
      connectionId: string;
      projectId?: string;
      sourceId?: string;
      sourceType?: string;
      rowCount?: number;
      columns?: string[];
      sheets?: Array<{ originalName: string; tableName: string; rowCount: number }>;
    }>("/api/data/upload", { method: "POST", body: formData }, token);
    const sheetCount = response.sheets?.length || 0;
    setUploadInfo(sheetCount > 0
      ? `Uploaded Excel source with ${sheetCount} sheet(s). Connection ID=${response.connectionId}`
      : `Uploaded ${response.rowCount} rows. Connection ID=${response.connectionId}`);
    form.reset();
    setUploadSourceName("");
    setUploadProjectId("");
    await loadConnections();
    await loadKnowledgeIntake(response.connectionId);
  }

  async function addPostgresConnection(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    try {
      const created = await apiCall<{ id?: string }>(
        "/api/connections",
        {
          method: "POST",
          body: JSON.stringify({
            type: "postgres",
            config: {
              connectionString: newPgConnectionString,
            },
            makeActive: true,
          }),
        },
        token,
      );
      setNewPgConnectionString("");
      setStatusMessage("PostgreSQL connection saved.");
      await loadConnections();
      if (created?.id) {
        await loadKnowledgeIntake(created.id);
      }
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  async function createMonitor(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    await apiCall(
      "/api/monitors",
      {
        method: "POST",
        body: JSON.stringify({
          name: monitorName,
          source: activeConnection?.type || "postgres",
          metricName: monitorMetric,
          scheduleCron: monitorCron,
          thresholdPercent: Number(monitorThreshold),
        }),
      },
      token,
    );
    setStatusMessage("Monitor created.");
    await loadMonitors();
  }

  async function loadMonitors() {
    if (!token) return;
    const list = await apiCall<Monitor[]>("/api/monitors", {}, token);
    setMonitors(list);
  }

  async function runMonitor(id: string) {
    if (!token) return;
    await apiCall(`/api/monitors/${id}/run`, { method: "POST" }, token);
    await loadMonitors();
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    await apiCall(
      "/api/auth/change-password",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword: passwordCurrent,
          newPassword: passwordNew,
        }),
      },
      token,
    );
    setPasswordCurrent("");
    setPasswordNew("");
    setStatusMessage("Password changed.");
  }

  function downloadRowsAsCsv(rows: ReportTableRow[]) {
    if (rows.length === 0) return;
    const csv = rowsToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "chat-results.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function submitChatMessage() {
    if (!token || !activeConnection || !chatInput.trim()) return;
    const userText = chatInput.trim();
    setChatMessages((prev) => [...prev, { role: "user", type: "text", content: userText }]);
    setChatInput("");
    setIsChatLoading(true);
    setChatStatuses(["thinking"]);
    try {
      const response = await apiCall<{
        sessionId: string;
        statuses: string[];
        messages: ChatMessage[];
      }>(
        "/api/chat",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: chatSessionId || undefined,
            connectionId: activeConnection.id,
            projectId:
              typeof activeConnection.config.projectId === "string"
                ? activeConnection.config.projectId
                : undefined,
            sourceId:
              typeof activeConnection.config.sourceId === "string"
                ? activeConnection.config.sourceId
                : activeConnection.id,
            sourceType: activeConnection.type,
            message: userText,
          }),
        },
        token,
      );
      setChatSessionId(response.sessionId);
      setChatStatuses(response.statuses || []);
      setChatMessages((prev) => [...prev, ...(response.messages || [])]);
      const sessions = await apiCall<{ sessions: ChatSessionSummary[] }>(
        `/api/chat/history?connectionId=${activeConnection.id}`,
        {},
        token,
      );
      setChatSessions(sessions.sessions || []);
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", type: "text", content: getErrorMessage(error) },
      ]);
    } finally {
      setIsChatLoading(false);
      setChatStatuses([]);
    }
  }

  async function sendChatMessage(e: FormEvent) {
    e.preventDefault();
    await submitChatMessage();
  }

  function handleChatInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!submitOnEnter) return;
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (isChatLoading || !activeConnection || !chatInput.trim()) return;
    void submitChatMessage();
  }

  async function openSession(sessionId: string) {
    if (!token || !sessionId) return;
    const payload = await apiCall<{
      session: { messages: ChatMessage[] } | null;
    }>(`/api/chat/history?sessionId=${sessionId}`, {}, token);
    setChatSessionId(sessionId);
    setChatMessages(payload.session?.messages || []);
    setActiveTab("chat");
  }

  const loadKnowledgeIntake = useCallback(async (connectionId: string, options?: { keepActiveTab?: boolean }) => {
    if (!token || !connectionId) return;
    const [questionsRes, prefillsRes, memoryRes] = await Promise.all([
      apiCall<{ questions: string[] }>(
        "/api/onboarding/questions",
        {
          method: "POST",
          body: JSON.stringify({ connectionId }),
        },
        token,
      ),
      apiCall<{ suggestions: Record<string, string> }>(
        "/api/onboarding/prefill",
        {
          method: "POST",
          body: JSON.stringify({ connectionId }),
        },
        token,
      ),
      apiCall<{ memoryExists: boolean; memory?: MemorySnapshot | null }>(
        `/api/memory/check?connectionId=${connectionId}`,
        {},
        token,
      ).catch(() => ({ memoryExists: false, memory: null })),
    ]);
    const fetchedQuestions = questionsRes.questions || [];
    const fetchedSuggestions = prefillsRes.suggestions || {};
    const memory = memoryRes?.memoryExists ? memoryRes.memory || null : null;
    const questions =
      memory?.suggestedQuestions && memory.suggestedQuestions.length > 0
        ? memory.suggestedQuestions
        : fetchedQuestions;
    setKnowledgeQuestions(questions);
    setKnowledgeAnswers(
      questions.map((question, index) => ({
        question,
        answer:
          index === 0
            ? memory?.businessContext || ""
            : index === 2
              ? memory?.primaryMetric || ""
              : index === 3
                ? memory?.timeContext?.start || ""
                : index === 4
                  ? memory?.defaultFilters?.[0] || ""
                  : index === 5
                    ? memory?.businessRules?.[0] || ""
                    : "",
      })),
    );
    setColumnSuggestions(fetchedSuggestions);
    setColumnMeanings({
      ...fetchedSuggestions,
      ...(memory?.columnMeanings || {}),
    });
    if (!options?.keepActiveTab) setActiveTab("knowledge");
  }, [token]);

  useEffect(() => {
    if (!token || !activeConnection?.id || activeTab !== "knowledge") return;
    void loadKnowledgeIntake(activeConnection.id, { keepActiveTab: true });
  }, [token, activeConnection?.id, activeTab, loadKnowledgeIntake]);

  async function saveKnowledgeBase() {
    if (!token || !activeConnection) return;
    setIsKnowledgeSaving(true);
    try {
      const answers = knowledgeAnswers.map((entry) => entry.answer.trim());
      await apiCall(
        "/api/onboarding/save",
        {
          method: "POST",
          body: JSON.stringify({
            connectionId: activeConnection.id,
            businessContext: answers[0] || "Business context not provided",
            domain: answers[0] || "General domain",
            primaryMetric: answers[2] || "Primary metric",
            timeContext: {
              start: answers[3] || "Unknown",
              frequency: answers[3] || "Unknown",
            },
            businessRules: answers[5] ? [answers[5]] : [],
            defaultFilters: answers[4] ? [answers[4]] : [],
            columnMeanings,
            suggestedQuestions: knowledgeQuestions,
          }),
        },
        token,
      );
      setStatusMessage("Knowledge base updated for this database.");
      setActiveTab("chat");
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    } finally {
      setIsKnowledgeSaving(false);
    }
  }

  return (
    <div className="container">
      {!isAuthed ? (
        <main className="auth-main">
          <div className="auth-shell">
            <section className="auth-hero">
              <p className="auth-badge">Data Insight Platform</p>
              <h1>Data Insight Platform</h1>
              <p className="sub">
                Connect your sources once and turn raw data into decisions, reports, and alerts.
              </p>
              <ul className="auth-highlights">
                <li>Conversational analytics across connected databases</li>
                <li>Automated monitoring and anomaly alerts</li>
                <li>Knowledge memory for faster follow-up answers</li>
                <li>CSV + PostgreSQL workflows in one workspace</li>
              </ul>
            </section>

            <section className="auth-panel card">
              <div className="auth-panel-head">
                <h2>{authMode === "login" ? "Login" : "Create account"}</h2>
                <p className="muted">
                  {authMode === "login"
                    ? "Sign in to continue with your data workspace."
                    : "Create your account to start building insights."}
                </p>
              </div>

              <div className="auth-mode-switch" role="tablist" aria-label="Authentication mode">
                <button
                  type="button"
                  className={authMode === "login" ? "auth-mode-btn active" : "auth-mode-btn"}
                  onClick={() => setAuthMode("login")}
                >
                  Business Login
                </button>
                <button
                  type="button"
                  className={authMode === "register" ? "auth-mode-btn active" : "auth-mode-btn"}
                  onClick={() => setAuthMode("register")}
                >
                  Register
                </button>
              </div>

              {statusMessage && <div className="msg auth-msg">{statusMessage}</div>}

              {authMode === "login" ? (
                <form className="auth-form" onSubmit={login}>
                  <input
                    placeholder="Email"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                  />
                  <input
                    placeholder="Password"
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                  <button type="submit">Login</button>
                </form>
              ) : (
                <form className="auth-form" onSubmit={register}>
                  <input
                    placeholder="Full name"
                    value={registerName}
                    onChange={(e) => setRegisterName(e.target.value)}
                    required
                  />
                  <input
                    placeholder="Email"
                    type="email"
                    value={registerEmail}
                    onChange={(e) => setRegisterEmail(e.target.value)}
                    required
                  />
                  <input
                    placeholder="Password"
                    type="password"
                    value={registerPassword}
                    onChange={(e) => setRegisterPassword(e.target.value)}
                    required
                  />
                  <button type="submit">Create account</button>
                </form>
              )}
            </section>
          </div>
        </main>
      ) : (
        <div className="app-layout">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-dot" />
              <div>
                <p className="brand-name">Data Insight</p>
              </div>
            </div>

            <div className="connection-switcher sidebar-switcher">
              <label htmlFor="quickConnectionSwitch">Active database</label>
              <div className="switch-select-wrap">
                <span className="switch-dot" aria-hidden="true" />
                <select
                  id="quickConnectionSwitch"
                  className="switch-select"
                  value={activeConnection?.id || ""}
                  onChange={(e) => void quickSwitchConnection(e.target.value)}
                  disabled={uniqueConnections.length === 0}
                >
                  {uniqueConnections.length === 0 ? (
                    <option value="">No saved connections</option>
                  ) : (
                    uniqueConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name} ({connection.type}) {connection.isActive ? "- Active" : ""}
                      </option>
                    ))
                  )}
                </select>
                <span className="switch-caret" aria-hidden="true">
                  v
                </span>
              </div>
            </div>

            <nav className="nav-list" aria-label="Main navigation">
              <p className="nav-group-title">Overview</p>
              <button
                type="button"
                className={
                  activeTab === "connections" ? "tab-btn tab-btn-dark active" : "tab-btn tab-btn-dark"
                }
                onClick={() => setActiveTab("connections")}
              >
                <span className="nav-icon" aria-hidden="true">
                  #
                </span>
                <span className="nav-label">Dashboard</span>
                <span className="nav-short">Dash</span>
              </button>
              <button
                type="button"
                className={
                  activeTab === "sessions" ? "tab-btn tab-btn-dark active" : "tab-btn tab-btn-dark"
                }
                onClick={() => setActiveTab("sessions")}
              >
                <span className="nav-icon" aria-hidden="true">
                  S
                </span>
                <span className="nav-label">Chat Sessions</span>
                <span className="nav-short">Sess</span>
              </button>
              <button
                type="button"
                className={
                  activeTab === "chat" ? "tab-btn tab-btn-dark active" : "tab-btn tab-btn-dark"
                }
                onClick={() => setActiveTab("chat")}
              >
                <span className="nav-icon" aria-hidden="true">
                  []
                </span>
                <span className="nav-label">Chat</span>
                <span className="nav-short">Chat</span>
              </button>
              <button
                type="button"
                className={
                  activeTab === "knowledge" ? "tab-btn tab-btn-dark active" : "tab-btn tab-btn-dark"
                }
                onClick={() => setActiveTab("knowledge")}
              >
                <span className="nav-icon" aria-hidden="true">
                  K
                </span>
                <span className="nav-label">Knowledge Base</span>
                <span className="nav-short">KB</span>
              </button>
              <button
                type="button"
                className={
                  activeTab === "automation" ? "tab-btn tab-btn-dark active" : "tab-btn tab-btn-dark"
                }
                onClick={() => setActiveTab("automation")}
              >
                <span className="nav-icon" aria-hidden="true">
                  @
                </span>
                <span className="nav-label">Services</span>
                <span className="nav-short">Svc</span>
              </button>
              <p className="nav-group-title account">Account</p>
              <button type="button" className="tab-btn tab-btn-dark muted-nav" disabled>
                <span className="nav-icon" aria-hidden="true">
                  *
                </span>
                <span className="nav-label">Notifications</span>
              </button>
              <button type="button" className="tab-btn tab-btn-dark muted-nav" disabled>
                <span className="nav-icon" aria-hidden="true">
                  =
                </span>
                <span className="nav-label">Settings</span>
              </button>
            </nav>

            <div className="sidebar-footer">
              <h3>Data Insight Platform</h3>
              <p>Convert your data into digital workflows, reports and alerts.</p>
              <button type="button" className="logout-btn" onClick={logout}>
                Logout
              </button>
            </div>
          </aside>

          <main className="main-content">
            <h1>Data Insight Platform</h1>
            <p className="sub">
              Connect data sources, run AI reports, and configure automation from one place.
            </p>
            {statusMessage && <div className="msg">{statusMessage}</div>}
            <div className="grid">
            {activeTab === "connections" && (
              <>
                <div className="card">
                  <h2>Saved Connections</h2>
                  <button type="button" onClick={() => loadConnections()}>
                    Refresh
                  </button>
                  {connections.length === 0 ? (
                    <p>No connections yet.</p>
                  ) : (
                    <div className="saved-connections-control">
                      <select
                        value={selectedSavedConnectionId}
                        onChange={(e) => setSelectedSavedConnectionId(e.target.value)}
                      >
                        <option value="">Select a saved connection</option>
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name} ({connection.type}){" "}
                            {connection.isActive ? "- Active" : "- Inactive"}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void removeSelectedConnection()}
                        disabled={!selectedSavedConnectionId}
                      >
                        Remove Selected
                      </button>
                    </div>
                  )}
                </div>

                <div className="card">
                  <h2>Add File Source</h2>
                  <form onSubmit={uploadFile}>
                    <input
                      placeholder="Source name (optional)"
                      value={uploadSourceName}
                      onChange={(event) => setUploadSourceName(event.target.value)}
                    />
                    <input
                      placeholder="Project ID (optional)"
                      value={uploadProjectId}
                      onChange={(event) => setUploadProjectId(event.target.value)}
                    />
                    <input name="file" type="file" accept=".csv,.xlsx,.xlsm,.xltx,.xltm" required />
                    <button type="submit">Upload & Save Source</button>
                  </form>
                  {uploadInfo && <p>{uploadInfo}</p>}
                </div>

                <form className="card" onSubmit={addPostgresConnection}>
                  <h2>Add PostgreSQL Connection</h2>
                  <input
                    placeholder="Postgres connection string"
                    value={newPgConnectionString}
                    onChange={(e) => setNewPgConnectionString(e.target.value)}
                    required
                  />
                  <button type="submit">Save & Activate</button>
                </form>

              </>
            )}

            {activeTab === "chat" && (
              <>
                <form className="card card-wide chat-card" onSubmit={sendChatMessage}>
                  <h2>Conversational Data Analyst</h2>
                  <p>
                    Active source:{" "}
                    {activeConnection
                      ? `${activeConnection.name} (${activeConnection.type})`
                      : "None"}
                  </p>
                  <div className="chat-feed">
                    {chatMessages.map((message, idx) => (
                      <div
                        key={`${idx}-${message.role}-${message.type || "text"}`}
                        className={`chat-bubble ${message.role}`}
                      >
                        <p>{message.content}</p>
                        {message.table && (
                          <div className="table-wrap">
                            <div className="chat-export-actions">
                              <button
                                type="button"
                                onClick={() => downloadRowsAsCsv(message.table?.rows || [])}
                              >
                                Download CSV
                              </button>
                            </div>
                            <table>
                              <thead>
                                <tr>
                                  {message.table.columns.map((column) => (
                                    <th key={column}>{column}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {message.table.rows.slice(0, 25).map((row, rowIndex) => (
                                  <tr key={rowIndex}>
                                    {message.table?.columns.map((column) => (
                                      <td key={column}>{String(row[column] ?? "")}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {message.chart && (
                          <div className="chart-wrap">
                            <Plot
                              data={message.chart.data as never[]}
                              layout={{
                                title: { text: message.chart.title, font: { size: 16 } },
                                autosize: true,
                                margin: { l: 50, r: 24, t: 56, b: 48 },
                                paper_bgcolor: "#ffffff",
                                plot_bgcolor: "#ffffff",
                                font: { color: "#0f172a" },
                                ...(message.chart.layout || {}),
                              }}
                              style={{ width: "100%", height: "360px" }}
                              config={{ responsive: true, displaylogo: false }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                    {isChatLoading && (
                      <div className="chat-bubble assistant">
                        <p>
                          {chatStatuses.includes("charting")
                            ? "Generating chart..."
                            : chatStatuses.includes("querying")
                              ? "Querying database..."
                              : "Thinking..."}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="chat-input-dock">
                    <label className="chat-enter-toggle">
                      <input
                        type="checkbox"
                        checked={submitOnEnter}
                        onChange={(e) => setSubmitOnEnter(e.target.checked)}
                      />
                      Enter to send (Shift+Enter for newline)
                    </label>
                    <div className="chat-composer">
                      <textarea
                        className="chat-composer-input"
                        placeholder="Ask follow-up questions naturally (e.g., now filter this for April)"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={handleChatInputKeyDown}
                        rows={2}
                        required
                      />
                      <button
                        className="chat-send-btn"
                        type="submit"
                        disabled={isChatLoading || !activeConnection || !chatInput.trim()}
                        aria-label="Send message"
                        title="Send (Enter)"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M3 20 21 12 3 4v6l12 2-12 2v6z" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </form>
              </>
            )}

            {activeTab === "sessions" && (
              <div className="card card-wide">
                <h2>Chat Sessions</h2>
                <p className="muted">
                  Open a session to switch context, then continue conversation in the Chat tab.
                </p>
                {chatSessions.length === 0 ? (
                  <p>No previous sessions for this connection.</p>
                ) : (
                  <div className="saved-connections-control">
                    {chatSessions.map((session) => (
                      <button
                        type="button"
                        key={session.sessionId}
                        onClick={() => void openSession(session.sessionId)}
                      >
                        {session.sessionId.slice(0, 8)} - Updated{" "}
                        {formatSessionUpdatedAt(session.updatedAt)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === "knowledge" && (
              <>
                <div className="card card-wide">
                  <h2>Knowledge Intake for Current Database</h2>
                  <p className="muted">
                    Capture business context once; the assistant reuses it across future chats.
                  </p>
                  <button
                    type="button"
                    onClick={() => activeConnection && void loadKnowledgeIntake(activeConnection.id)}
                    disabled={!activeConnection}
                  >
                    Refresh Knowledge Questions
                  </button>
                </div>
                <div className="card card-wide knowledge-chat">
                  {knowledgeAnswers.length === 0 ? (
                    <p>No knowledge prompts loaded yet. Click refresh above.</p>
                  ) : (
                    knowledgeAnswers.map((item, index) => (
                      <div key={item.question} className="knowledge-entry">
                        <div className="chat-bubble assistant">
                          <p>{item.question}</p>
                        </div>
                        <textarea
                          rows={2}
                          placeholder="Type your answer..."
                          value={item.answer}
                          onChange={(event) =>
                            setKnowledgeAnswers((prev) =>
                              prev.map((entry, idx) =>
                                idx === index ? { ...entry, answer: event.target.value } : entry,
                              ),
                            )
                          }
                        />
                      </div>
                    ))
                  )}
                </div>
                {Object.keys(columnSuggestions).length > 0 && (
                  <div className="card card-wide">
                    <h3>Column Description Confirmation</h3>
                    <div className="saved-connections-control">
                      {Object.entries(columnSuggestions).map(([column, suggestion]) => (
                        <label key={column}>
                          <span>{column}</span>
                          <input
                            value={columnMeanings[column] || suggestion}
                            onChange={(event) =>
                              setColumnMeanings((prev) => ({
                                ...prev,
                                [column]: event.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="card card-wide">
                  <button
                    type="button"
                    onClick={() => void saveKnowledgeBase()}
                    disabled={
                      isKnowledgeSaving ||
                      !activeConnection ||
                      knowledgeAnswers.some((item) => !item.answer.trim())
                    }
                  >
                    {isKnowledgeSaving ? "Saving..." : "Save to Knowledge Base"}
                  </button>
                </div>
              </>
            )}

            {activeTab === "automation" && (
              <>
                <form className="card" onSubmit={createMonitor}>
                  <h2>Automation & Alarm Setup</h2>
                  <p className="muted">
                    Default schedule checks every 12 hours with 10% threshold.
                  </p>
                  <input
                    placeholder="Monitor name (e.g. TAT monitor)"
                    value={monitorName}
                    onChange={(e) => setMonitorName(e.target.value)}
                    required
                  />
                  <input
                    placeholder="Metric name"
                    value={monitorMetric}
                    onChange={(e) => setMonitorMetric(e.target.value)}
                    required
                  />
                  <input
                    placeholder="Cron expression"
                    value={monitorCron}
                    onChange={(e) => setMonitorCron(e.target.value)}
                    required
                  />
                  <input
                    type="number"
                    value={monitorThreshold}
                    onChange={(e) => setMonitorThreshold(Number(e.target.value))}
                    min={0}
                    max={100}
                  />
                  <button type="submit">Create Monitor</button>
                  <button type="button" onClick={loadMonitors}>
                    Refresh Monitors
                  </button>
                </form>

                <div className="card">
                  <h2>Monitors & Alerts</h2>
                  {monitors.length === 0 ? (
                    <p>No monitors loaded.</p>
                  ) : (
                    monitors.map((monitor) => (
                      <div key={monitor.id} className="monitor">
                        <p>
                          <b>{monitor.name}</b> - {monitor.metricName} (
                          {monitor.thresholdPercent}% threshold)
                        </p>
                        <p>Cron: {monitor.scheduleCron}</p>
                        <button type="button" onClick={() => runMonitor(monitor.id)}>
                          Run now
                        </button>
                        <ul>
                          {(monitor.alerts || []).map((alert) => (
                            <li key={alert.id}>
                              {alert.message} ({new Date(alert.triggeredAt).toLocaleString()})
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </div>

                <form className="card" onSubmit={changePassword}>
                  <h2>Account Security</h2>
                  <input
                    type="password"
                    placeholder="Current password"
                    value={passwordCurrent}
                    onChange={(e) => setPasswordCurrent(e.target.value)}
                    required
                  />
                  <input
                    type="password"
                    placeholder="New password"
                    value={passwordNew}
                    onChange={(e) => setPasswordNew(e.target.value)}
                    required
                  />
                  <button type="submit">Update Password</button>
                </form>
              </>
            )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

export default App;
