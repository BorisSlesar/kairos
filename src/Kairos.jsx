import { useState, useEffect, useRef, useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";

// ————————————————————————————————————————————————
// Notion wiring — Boris's "Freelance Time Tracker" database
// ————————————————————————————————————————————————
const STORAGE_KEY = "kairos:v1";

const CHART_COLORS = ["#2C4BFF", "#0E9F6E", "#E8A33D", "#8B5CF6", "#EF6C57", "#0EA5B7", "#64748B", "#D0488F"];

// Palette for client color-coding
const CLIENT_PALETTE = ["#2C4BFF", "#0E9F6E", "#8B5CF6", "#EF6C57", "#0EA5B7", "#D0488F", "#E8A33D", "#5B6472"];

// Stable hash → same name always maps to the same color
const hashString = (str) => {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
};
const clientColor = (name) => (name ? CLIENT_PALETTE[hashString("c:" + name) % CLIENT_PALETTE.length] : "#C4C4C4");

// Load jsPDF on demand (code-split so it's not in the initial bundle)
const loadJsPDF = async () => {
  const mod = await import("jspdf");
  return mod.jsPDF;
};

// Draw a donut chart to a canvas and return a PNG data URL
const renderPieToPng = (slices, colors, size = 320) => {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const total = slices.reduce((s, d) => s + d.hours, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 4, inner = r * 0.55;
  let angle = -Math.PI / 2;
  slices.forEach((d, i) => {
    const slice = (d.hours / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    angle += slice;
  });
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
};

const fmtHM = (ms) => {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return { h, m, s };
};

const fmtHours = (hours) =>
  hours >= 1 ? `${hours.toFixed(2)} h` : `${Math.round(hours * 60)} min`;

const fmtMoney = (n, cur) =>
  new Intl.NumberFormat("sk-SK", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);

// Turn Notion's raw technical errors into plain, human language.
const humanizeError = (raw) => {
  const msg = String(raw || "");
  if (/invalid select value/i.test(msg))
    return "Notion didn't recognize the client or project tag, and couldn't add it automatically. Try again — if it keeps failing, add the tag manually in Notion first.";
  if (/max_tokens|cut off/i.test(msg))
    return "The save was interrupted partway. Check Notion before trying again — the entry may already be there.";
  if (/401|403|unauthorized|permission|access/i.test(msg))
    return "Couldn't reach your Notion database — the connection may not have access to it.";
  if (/429|rate.?limit/i.test(msg))
    return "Notion's a little busy right now. Give it a moment, then try again.";
  if (/network|failed to fetch|timeout|HTTP 5\d\d/i.test(msg))
    return "Couldn't connect to Notion just now. Check your connection and try again.";
  if (/unexpected response|empty/i.test(msg))
    return "The save may have gone through, but Notion didn't confirm it. Check the database before trying again.";
  return "Something went sideways on the way to Notion. Try again in a moment.";
};

export default function Kairos() {
  // Form state
  const [task, setTask] = useState("");
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState("EUR");

  // Timer state
  const [running, setRunning] = useState(null); // { startedAt, task, client, project, rate, currency }
  const [now, setNow] = useState(Date.now());

  // Data
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [chartProject, setChartProject] = useState("__all__");
  const [notice, setNotice] = useState(null);
  const tickRef = useRef(null);

  // ——— Load persisted state (localStorage) ———
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        setEntries(data.entries || []);
        if (data.running) {
          setRunning(data.running);
          setTask(data.running.task || "");
          setClient(data.running.client || "");
          setProject(data.running.project || "");
          setRate(data.running.rate || "");
          setCurrency(data.running.currency || "EUR");
        } else if (data.lastForm) {
          setClient(data.lastForm.client || "");
          setProject(data.lastForm.project || "");
          setRate(data.lastForm.rate || "");
          setCurrency(data.lastForm.currency || "EUR");
        }
      }
    } catch (e) {
      // First run — nothing stored yet
    }
    setLoaded(true);
  }, []);

  // ——— Persist on change (localStorage) ———
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          entries,
          running,
          lastForm: { client, project, rate, currency },
        })
      );
    } catch (e) {
      console.error("Storage save failed", e);
    }
  }, [entries, running, client, project, rate, currency, loaded]);

  // ——— Tick while running ———
  useEffect(() => {
    if (running) {
      tickRef.current = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(tickRef.current);
    }
  }, [running]);

  const elapsed = running ? Math.max(0, now - running.startedAt) : 0;
  const digits = fmtHM(elapsed);

  const knownClients = useMemo(
    () => [...new Set(entries.map((e) => e.client).filter(Boolean))],
    [entries]
  );
  const knownProjects = useMemo(
    () => [...new Set(entries.map((e) => e.project).filter(Boolean))],
    [entries]
  );

  // ——— On-screen totals: this week, this month, per client ———
  const summary = useMemo(() => {
    const now = new Date();
    // Week starts Monday
    const day = (now.getDay() + 6) % 7;
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let weekH = 0, monthH = 0;
    const weekEarn = {}, monthEarn = {};
    const byClient = {};
    for (const e of entries) {
      const t = new Date(e.start).getTime();
      const amt = e.durationH * e.rate;
      if (t >= weekStart) {
        weekH += e.durationH;
        if (amt) weekEarn[e.currency] = (weekEarn[e.currency] || 0) + amt;
      }
      if (t >= monthStart) {
        monthH += e.durationH;
        if (amt) monthEarn[e.currency] = (monthEarn[e.currency] || 0) + amt;
      }
      const c = e.client || "No client";
      if (t >= monthStart) {
        if (!byClient[c]) byClient[c] = { hours: 0, earn: {} };
        byClient[c].hours += e.durationH;
        if (amt) byClient[c].earn[e.currency] = (byClient[c].earn[e.currency] || 0) + amt;
      }
    }
    const clients = Object.entries(byClient)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.hours - a.hours);
    return { weekH, monthH, weekEarn, monthEarn, clients };
  }, [entries]);

  // ——— Timer controls ———
  const startTimer = () => {
    if (!task.trim()) {
      setNotice({ tone: "warn", text: "Give it a name first — then the clock starts." });
      return;
    }
    setNotice(null);
    setRunning({
      startedAt: Date.now(),
      task: task.trim(),
      client: client.trim(),
      project: project.trim(),
      rate,
      currency,
    });
  };

  const stopTimer = async () => {
    if (!running) return;
    const end = Date.now();
    const durationH = Math.max(0.01, +((end - running.startedAt) / 3600000).toFixed(2));
    const entry = {
      id: `e${end}`,
      task: running.task,
      client: running.client,
      project: running.project,
      rate: parseFloat(running.rate) || 0,
      currency: running.currency,
      start: new Date(running.startedAt).toISOString(),
      end: new Date(end).toISOString(),
      durationH,
    };
    setRunning(null);
    setTask("");
    setEntries((prev) => [entry, ...prev]);
  };

  // ——— Manual entry ———
  const [manualOpen, setManualOpen] = useState(false);
  const [mTask, setMTask] = useState("");
  const [mClient, setMClient] = useState("");
  const [mProject, setMProject] = useState("");
  const [mStart, setMStart] = useState("");
  const [mEnd, setMEnd] = useState("");
  const [mRate, setMRate] = useState("");
  const [mCurrency, setMCurrency] = useState("EUR");

  const mStartMs = mStart ? new Date(mStart).getTime() : NaN;
  const mEndMs = mEnd ? new Date(mEnd).getTime() : NaN;
  const mValid = mTask.trim() && !isNaN(mStartMs) && !isNaN(mEndMs) && mEndMs > mStartMs;
  const mDurationH = mValid ? +((mEndMs - mStartMs) / 3600000).toFixed(2) : 0;

  const openManual = () => {
    // Prefill both times to now — you set the real span yourself
    const nowLocal = toLocalInput(new Date().toISOString());
    setMTask("");
    setMClient(client);
    setMProject(project);
    setMStart(nowLocal);
    setMEnd(nowLocal);
    setMRate(rate);
    setMCurrency(currency);
    setManualOpen(true);
    setNotice(null);
  };
  const cancelManual = () => setManualOpen(false);
  const saveManual = () => {
    if (!mValid) return;
    const id = `e${Date.now()}`;
    const entry = {
      id,
      task: mTask.trim(),
      client: mClient.trim(),
      project: mProject.trim(),
      rate: parseFloat(mRate) || 0,
      currency: mCurrency,
      start: new Date(mStartMs).toISOString(),
      end: new Date(mEndMs).toISOString(),
      durationH: mDurationH,
    };
    setEntries((prev) => [entry, ...prev].sort((a, b) => new Date(b.start) - new Date(a.start)));
    setManualOpen(false);
  };

  // ——— Export (time by activity, per client/project) ———
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invClient, setInvClient] = useState("");
  const [invPeriodStart, setInvPeriodStart] = useState("");
  const [invPeriodEnd, setInvPeriodEnd] = useState("");
  const [generating, setGenerating] = useState(false);

  const openInvoice = () => {
    const firstClient = knownClients[0] || "";
    const nowD = new Date();
    const first = new Date(nowD.getFullYear(), nowD.getMonth(), 1);
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setInvClient(firstClient);
    setInvPeriodStart(iso(first));
    setInvPeriodEnd(iso(nowD));
    setInvoiceOpen(true);
  };

  // Entries for the chosen client within the chosen period (inclusive of end day)
  const invoiceEntries = useMemo(() => {
    if (!invClient || !invPeriodStart || !invPeriodEnd) return [];
    const startMs = new Date(invPeriodStart + "T00:00").getTime();
    const endMs = new Date(invPeriodEnd + "T23:59:59").getTime();
    return entries.filter((e) => {
      if (e.client !== invClient) return false;
      const t = new Date(e.start).getTime();
      return t >= startMs && t <= endMs;
    });
  }, [entries, invClient, invPeriodStart, invPeriodEnd]);

  // Group: project → task → { hours, amount, rate, currency }
  const invoiceModel = useMemo(() => {
    const projects = {};
    let grandHours = 0;
    const currencies = new Set();
    for (const e of invoiceEntries) {
      const proj = e.project || "No project";
      const task = e.task || "Untitled";
      currencies.add(e.currency);
      if (!projects[proj]) projects[proj] = { tasks: {}, hours: 0, amount: 0 };
      if (!projects[proj].tasks[task]) projects[proj].tasks[task] = { hours: 0, amount: 0, rate: e.rate, currency: e.currency };
      projects[proj].tasks[task].hours += e.durationH;
      projects[proj].tasks[task].amount += e.durationH * e.rate;
      projects[proj].hours += e.durationH;
      projects[proj].amount += e.durationH * e.rate;
      grandHours += e.durationH;
    }
    // Per-project pie slices (that project's own tasks)
    for (const proj of Object.keys(projects)) {
      projects[proj].pie = Object.entries(projects[proj].tasks)
        .map(([name, t]) => ({ name, hours: +t.hours.toFixed(2) }))
        .sort((a, b) => b.hours - a.hours);
    }
    const grandAmount = Object.values(projects).reduce((s, p) => s + p.amount, 0);
    // Task totals across the whole invoice, for the pie chart
    const taskTotals = {};
    for (const e of invoiceEntries) {
      const task = e.task || "Untitled";
      taskTotals[task] = (taskTotals[task] || 0) + e.durationH;
    }
    const pie = Object.entries(taskTotals)
      .map(([name, hours]) => ({ name, hours: +hours.toFixed(2) }))
      .sort((a, b) => b.hours - a.hours);
    return { projects, grandHours, grandAmount, currencies: [...currencies], pie };
  }, [invoiceEntries]);

  const money = (n, cur) =>
    new Intl.NumberFormat("en-IE", { style: "currency", currency: cur || "EUR", maximumFractionDigits: 2 }).format(n || 0);

  const generateInvoicePdf = async () => {
    if (invoiceEntries.length === 0) return;
    setGenerating(true);
    try {
      const JsPDF = await loadJsPDF();
      const doc = new JsPDF({ unit: "pt", format: "a4" });
      const W = doc.internal.pageSize.getWidth();
      const M = 48; // margin
      let y = M;
      const cur = invoiceModel.currencies[0] || "EUR";
      const mixedCurrency = invoiceModel.currencies.length > 1;

      // Draws a donut with a legend at the current y; returns the new y below the taller of the two
      const drawDonut = (slices, pieSize = 130) => {
        if (!slices || slices.length === 0) return y;
        if (y + pieSize > 800) { doc.addPage(); y = M; }
        const png = renderPieToPng(slices, CHART_COLORS, 320);
        doc.addImage(png, "PNG", M, y, pieSize, pieSize);
        const total = slices.reduce((s, d) => s + d.hours, 0) || 1;
        let ly = y + 10;
        doc.setFontSize(9);
        doc.setTextColor(20);
        slices.forEach((d, i) => {
          const c = CHART_COLORS[i % CHART_COLORS.length];
          const rgb = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
          doc.setFillColor(rgb[0], rgb[1], rgb[2]);
          doc.rect(M + pieSize + 20, ly - 8, 9, 9, "F");
          const pct = Math.round((d.hours / total) * 100);
          const label = doc.splitTextToSize(`${d.name} — ${d.hours.toFixed(2)} h (${pct}%)`, W - M - (M + pieSize + 36));
          doc.text(label, M + pieSize + 36, ly, { baseline: "middle" });
          ly += Math.max(14, label.length * 12);
        });
        return Math.max(y + pieSize, ly) + 8;
      };

      // Header
      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.text("Kairos — time export", M, y);
      doc.setFont("helvetica", "normal");
      y += 26;
      doc.setFontSize(11);
      doc.text(invClient || "—", M, y);
      y += 16;
      doc.setFontSize(9);
      doc.setTextColor(120);
      doc.text(`Period: ${invPeriodStart} to ${invPeriodEnd}`, M, y);
      doc.text(`Generated ${new Date().toLocaleDateString("en-GB")}`, W - M, y, { align: "right" });
      doc.setTextColor(20);
      y += 16;
      doc.setDrawColor(220);
      doc.line(M, y, W - M, y);
      y += 22;

      // Project sections
      const projNames = Object.keys(invoiceModel.projects);
      projNames.forEach((proj) => {
        const p = invoiceModel.projects[proj];
        if (y > 720) { doc.addPage(); y = M; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text(proj, M, y);
        doc.setFont("helvetica", "normal");
        y += 6;
        doc.setDrawColor(235);
        doc.line(M, y, W - M, y);
        y += 16;

        // Column headers
        doc.setFontSize(9);
        doc.setTextColor(140);
        doc.text("Task", M, y);
        doc.text("Hours", W - M - 200, y, { align: "right" });
        doc.text("Rate", W - M - 100, y, { align: "right" });
        doc.text("Amount", W - M, y, { align: "right" });
        doc.setTextColor(20);
        y += 6;
        doc.setDrawColor(235);
        doc.line(M, y, W - M, y);
        y += 15;

        doc.setFontSize(10);
        Object.entries(p.tasks).forEach(([taskName, t]) => {
          if (y > 760) { doc.addPage(); y = M; }
          const nameLines = doc.splitTextToSize(taskName, W - M - 260);
          doc.text(nameLines, M, y);
          doc.text(t.hours.toFixed(2), W - M - 200, y, { align: "right" });
          doc.text(money(t.rate, t.currency), W - M - 100, y, { align: "right" });
          doc.text(money(t.amount, t.currency), W - M, y, { align: "right" });
          y += nameLines.length * 13 + 4;
        });

        // Project subtotal
        y += 2;
        doc.setDrawColor(235);
        doc.line(W - M - 260, y, W - M, y);
        y += 14;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(`Subtotal — ${proj}`, W - M - 260, y, { align: "right" });
        doc.text(p.hours.toFixed(2) + " h", W - M - 200, y, { align: "right" });
        doc.text(money(p.amount, cur), W - M, y, { align: "right" });
        doc.setFont("helvetica", "normal");
        y += 20;

        // Per-project pie: this project's own task split
        doc.setFontSize(9);
        doc.setTextColor(120);
        doc.text("Time by activity", M, y);
        doc.setTextColor(20);
        y += 10;
        y = drawDonut(p.pie, 120);
        y += 8;
      });

      // Grand total
      if (y > 700) { doc.addPage(); y = M; }
      doc.setDrawColor(180);
      doc.setLineWidth(1);
      doc.line(M, y, W - M, y);
      doc.setLineWidth(0.2);
      y += 20;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text("Total billable", M, y);
      doc.text(`${invoiceModel.grandHours.toFixed(2)} h`, W - M - 160, y, { align: "right" });
      doc.text(mixedCurrency ? "see line items" : money(invoiceModel.grandAmount, cur), W - M, y, { align: "right" });
      doc.setFont("helvetica", "normal");
      y += 10;
      if (mixedCurrency) {
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text("Entries use more than one currency; billable is itemized per line.", M, y + 8);
        doc.setTextColor(20);
      }
      y += 30;

      // Overall pie chart: time by task across the whole export
      if (invoiceModel.pie.length > 0) {
        if (y > 560) { doc.addPage(); y = M; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("Overall — time by activity", M, y);
        doc.setFont("helvetica", "normal");
        y += 4;
        doc.setFontSize(9);
        doc.setTextColor(120);
        doc.text(
          mixedCurrency
            ? `Total billable: see line items · ${invoiceModel.grandHours.toFixed(2)} h`
            : `Billable (${cur}): ${money(invoiceModel.grandAmount, cur)} · ${invoiceModel.grandHours.toFixed(2)} h`,
          M, y + 10
        );
        doc.setTextColor(20);
        y += 22;
        y = drawDonut(invoiceModel.pie, 150);
      }

      const safeClient = (invClient || "client").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      doc.save(`kairos-export-${safeClient}-${invPeriodStart}-to-${invPeriodEnd}.pdf`);
      setInvoiceOpen(false);
    } catch (err) {
      console.error("Export failed", err);
      setNotice({ tone: "warn", text: humanizeError(String(err?.message || err)) });
    } finally {
      setGenerating(false);
    }
  };

  // ——— Notion sync via Claude + Notion MCP ———
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const deleteEntry = (entry) => {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    setConfirmDeleteId(null);
  };

  // ——— Backup / restore ———
  const fileInputRef = useRef(null);
  const exportBackup = () => {
    const payload = { app: "kairos", version: 1, exportedAt: new Date().toISOString(), entries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kairos-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importBackup = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = Array.isArray(data) ? data : data.entries;
        if (!Array.isArray(incoming)) throw new Error("This file doesn't look like a time-tracker backup.");
        // Merge by id — keep existing, add any new ones, without duplicating
        setEntries((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          let added = 0;
          for (const e of incoming) {
            if (e && e.id && !byId.has(e.id)) { byId.set(e.id, e); added++; }
          }
          setNotice({ tone: "info", text: `Restored ${added} ${added === 1 ? "entry" : "entries"} from backup.` });
          return [...byId.values()].sort((a, b) => new Date(b.start) - new Date(a.start));
        });
      } catch (err) {
        setNotice({ tone: "warn", text: humanizeError(String(err?.message || err)) });
      }
    };
    reader.onerror = () => setNotice({ tone: "warn", text: "Couldn't read that file. Try again." });
    reader.readAsText(file);
  };


  // ——— Editing a saved entry (task, client, project, start/end times) ———
  const [editingId, setEditingId] = useState(null);
  const [editTask, setEditTask] = useState("");
  const [editClient, setEditClient] = useState("");
  const [editProject, setEditProject] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");

  // Convert an ISO string to the value a datetime-local input expects (local time, no seconds/TZ)
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const editStartMs = editStart ? new Date(editStart).getTime() : NaN;
  const editEndMs = editEnd ? new Date(editEnd).getTime() : NaN;
  const editValid = !isNaN(editStartMs) && !isNaN(editEndMs) && editEndMs > editStartMs;
  const editDurationH = editValid ? +((editEndMs - editStartMs) / 3600000).toFixed(2) : 0;

  const beginEdit = (e) => {
    setEditingId(e.id);
    setEditTask(e.task);
    setEditClient(e.client || "");
    setEditProject(e.project || "");
    setEditStart(toLocalInput(e.start));
    setEditEnd(toLocalInput(e.end));
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditTask("");
    setEditClient("");
    setEditProject("");
    setEditStart("");
    setEditEnd("");
  };
  const saveEdit = async (entry) => {
    const newTask = editTask.trim();
    if (!newTask || !editValid) return;
    const updated = {
      ...entry,
      task: newTask,
      client: editClient.trim(),
      project: editProject.trim(),
      start: new Date(editStartMs).toISOString(),
      end: new Date(editEndMs).toISOString(),
      durationH: editDurationH,
    };
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? updated : e)));
    cancelEdit();
  };


  const projectEntries = useMemo(
    () =>
      chartProject === "__all__"
        ? entries
        : entries.filter((e) => e.project === chartProject),
    [entries, chartProject]
  );

  const pieData = useMemo(() => {
    const byTask = {};
    for (const e of projectEntries) {
      byTask[e.task] = (byTask[e.task] || 0) + e.durationH;
    }
    return Object.entries(byTask)
      .map(([name, value]) => ({ name, value: +value.toFixed(2) }))
      .sort((a, b) => b.value - a.value);
  }, [projectEntries]);

  const totalHours = pieData.reduce((s, d) => s + d.value, 0);
  const earningsByCurrency = useMemo(() => {
    const sums = {};
    for (const e of projectEntries) {
      const amt = e.durationH * e.rate;
      if (amt > 0) sums[e.currency] = (sums[e.currency] || 0) + amt;
    }
    return sums;
  }, [projectEntries]);

  const inputCls =
    "w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400";

  return (
    <div className="min-h-screen" style={{ background: "#EEF0F3", color: "#14161B", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap');
        .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
        @keyframes pulseDot { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
        .live-dot { animation: pulseDot 1.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } }
      `}</style>

      {/* ——— Chronometer band ——— */}
      <div style={{ background: "#14161B" }} className="px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-center justify-between">
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-white">Kairos</span>
              <span className="text-xs font-medium uppercase tracking-widest text-gray-500">Time tracker</span>
            </span>
            {running && (
              <span className="flex items-center gap-2 text-xs font-medium text-emerald-400">
                <span className="live-dot inline-block h-2 w-2 rounded-full bg-emerald-400" />
                Tracking
              </span>
            )}
          </div>

          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex-1 space-y-3">
              <input
                className={`${inputCls} text-base`}
                placeholder="What are you working on?"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                disabled={!!running}
                list="task-suggestions"
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <input className={inputCls} placeholder="Client" value={client} onChange={(e) => setClient(e.target.value)} disabled={!!running} list="client-suggestions" />
                <input className={inputCls} placeholder="Project" value={project} onChange={(e) => setProject(e.target.value)} disabled={!!running} list="project-suggestions" />
                <input className={inputCls} placeholder="Rate / h" type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!!running} />
                <select className={inputCls} value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!!running}>
                  <option value="EUR">EUR</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <datalist id="client-suggestions">{knownClients.map((c) => <option key={c} value={c} />)}</datalist>
              <datalist id="project-suggestions">{knownProjects.map((p) => <option key={p} value={p} />)}</datalist>
            </div>

            <div className="flex items-end gap-5">
              <div className="mono text-5xl font-semibold text-white sm:text-6xl" aria-live="polite">
                {digits.h}<span className="text-gray-500">:</span>{digits.m}<span className="text-gray-500">:</span>{digits.s}
              </div>
              {running ? (
                <button
                  onClick={stopTimer}
                  className="rounded-md bg-white px-6 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  Stop &amp; save
                </button>
              ) : (
                <div className="flex items-center gap-3">
                  <button
                    onClick={startTimer}
                    className="rounded-md px-6 py-3 text-sm font-semibold text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    style={{ background: "#2C4BFF" }}
                  >
                    Start timer
                  </button>
                  <button
                    onClick={openManual}
                    className="rounded-md border border-gray-600 px-5 py-3 text-sm font-semibold text-gray-200 hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  >
                    Add manually
                  </button>
                </div>
              )}
            </div>
          </div>
          {notice && <p className={`mt-3 text-sm ${notice.tone === "info" ? "text-blue-300" : "text-amber-400"}`}>{notice.text}</p>}

          {manualOpen && (
            <div className="mt-5 rounded-lg border border-gray-700 bg-gray-900 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Add a past session</h3>
                <button onClick={cancelManual} className="text-gray-500 hover:text-gray-300" aria-label="Close manual entry">✕</button>
              </div>
              <div className="space-y-3">
                <input className={inputCls} placeholder="What did you work on?" value={mTask} onChange={(e) => setMTask(e.target.value)} list="task-suggestions-m" autoFocus />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <input className={inputCls} placeholder="Client" value={mClient} onChange={(e) => setMClient(e.target.value)} list="client-suggestions" />
                  <input className={inputCls} placeholder="Project" value={mProject} onChange={(e) => setMProject(e.target.value)} list="project-suggestions" />
                  <input className={inputCls} placeholder="Rate / h" type="number" min="0" value={mRate} onChange={(e) => setMRate(e.target.value)} />
                  <select className={inputCls} value={mCurrency} onChange={(e) => setMCurrency(e.target.value)}>
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-400">Started</label>
                    <input type="datetime-local" className={inputCls + " mono"} value={mStart} onChange={(e) => setMStart(e.target.value)} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-400">Ended</label>
                    <input type="datetime-local" className={inputCls + " mono"} value={mEnd} onChange={(e) => setMEnd(e.target.value)} />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">
                    {mStart && mEnd && mEndMs <= mStartMs
                      ? <span className="text-amber-400">End time needs to come after the start.</span>
                      : mValid
                        ? <>Duration: <span className="mono font-semibold text-gray-200">{fmtHours(mDurationH)}</span></>
                        : <>Fill in the task and both times.</>}
                  </span>
                  <div className="flex items-center gap-2">
                    <button onClick={cancelManual} className="rounded-md px-3 py-2 text-sm text-gray-300 hover:bg-gray-800">Cancel</button>
                    <button
                      onClick={saveManual}
                      disabled={!mValid}
                      className="rounded-md px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      style={{ background: "#2C4BFF" }}
                    >
                      Add entry
                    </button>
                  </div>
                </div>
              </div>
              <datalist id="task-suggestions-m">{[...new Set(entries.map((e) => e.task).filter(Boolean))].map((t) => <option key={t} value={t} />)}</datalist>
            </div>
          )}
        </div>
      </div>

      {/* ——— At-a-glance totals ——— */}
      {entries.length > 0 && (
        <div className="mx-auto max-w-5xl px-5 pt-6 sm:px-8">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <p className="text-xs text-gray-500">This week</p>
              <p className="mono mt-0.5 text-lg font-semibold">{fmtHours(summary.weekH)}</p>
              <p className="mono text-xs text-gray-500">
                {Object.entries(summary.weekEarn).map(([c, a]) => fmtMoney(a, c)).join(" · ") || "—"}
              </p>
            </div>
            <div className="rounded-lg bg-white p-3 shadow-sm">
              <p className="text-xs text-gray-500">This month</p>
              <p className="mono mt-0.5 text-lg font-semibold">{fmtHours(summary.monthH)}</p>
              <p className="mono text-xs text-gray-500">
                {Object.entries(summary.monthEarn).map(([c, a]) => fmtMoney(a, c)).join(" · ") || "—"}
              </p>
            </div>
            <div className="col-span-2 rounded-lg bg-white p-3 shadow-sm">
              <p className="mb-1 text-xs text-gray-500">By client (this month)</p>
              <div className="space-y-0.5">
                {summary.clients.slice(0, 3).map((c) => (
                  <div key={c.name} className="flex items-center justify-between text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: c.name === "No client" ? "#C4C4C4" : clientColor(c.name) }} />
                      <span className="truncate text-gray-700">{c.name}</span>
                    </span>
                    <span className="mono text-xs text-gray-500">
                      {fmtHours(c.hours)}{Object.keys(c.earn).length > 0 && " · " + Object.entries(c.earn).map(([cu, a]) => fmtMoney(a, cu)).join(" · ")}
                    </span>
                  </div>
                ))}
                {summary.clients.length > 3 && <p className="text-xs text-gray-400">+{summary.clients.length - 3} more</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ——— Body ——— */}
      <div className="mx-auto grid max-w-5xl gap-6 px-5 py-8 sm:px-8 lg:grid-cols-5">
        {/* Ledger */}
        <div className="lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Entries</h2>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(ev) => { const f = ev.target.files?.[0]; if (f) importBackup(f); ev.target.value = ""; }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                title="Restore entries from a backup file"
              >
                Restore
              </button>
              <button
                onClick={exportBackup}
                disabled={entries.length === 0}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                title="Download all entries as a JSON backup"
              >
                Backup
              </button>
              <button
                onClick={openInvoice}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                Export PDF
              </button>
            </div>
          </div>
          {entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
              Nothing tracked yet. Start the clock and your first entry lands here.
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((e) => (
                <li key={e.id} className="rounded-lg bg-white p-4 shadow-sm" style={{ borderLeft: `3px solid ${e.client ? clientColor(e.client) : "#E5E7EB"}` }}>
                  {editingId === e.id ? (
                    <div className="space-y-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-gray-500">Task</label>
                        <input
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          value={editTask}
                          onChange={(ev) => setEditTask(ev.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-gray-500">Client</label>
                          <input
                            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={editClient}
                            onChange={(ev) => setEditClient(ev.target.value)}
                            list="client-suggestions"
                            placeholder="No client"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-gray-500">Project</label>
                          <input
                            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={editProject}
                            onChange={(ev) => setEditProject(ev.target.value)}
                            list="project-suggestions"
                            placeholder="No project"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-gray-500">Started</label>
                          <input
                            type="datetime-local"
                            className="mono w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={editStart}
                            onChange={(ev) => setEditStart(ev.target.value)}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-gray-500">Ended</label>
                          <input
                            type="datetime-local"
                            className="mono w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={editEnd}
                            onChange={(ev) => setEditEnd(ev.target.value)}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">
                          {editValid
                            ? <>Duration: <span className="mono font-semibold text-gray-700">{fmtHours(editDurationH)}</span></>
                            : <span className="text-amber-600">End time needs to come after the start.</span>}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => saveEdit(e)}
                          disabled={!editValid || !editTask.trim()}
                          className="rounded-md px-4 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ background: "#2C4BFF" }}
                        >
                          Save changes
                        </button>
                        <button onClick={cancelEdit} className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                  <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{e.task}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                        {e.client && (
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: clientColor(e.client) }} />
                            {e.client}
                          </span>
                        )}
                        {e.project && <span className="text-gray-500">{e.project}</span>}
                        {!e.client && !e.project && <span className="text-gray-400">No client or project yet</span>}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="mono text-sm font-semibold">{fmtHours(e.durationH)}</p>
                      {e.rate > 0 && (
                        <p className="mono text-xs text-gray-500">{fmtMoney(e.durationH * e.rate, e.currency)}</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-gray-400">
                      {new Date(e.start).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      {" – "}
                      {new Date(e.end).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <button onClick={() => beginEdit(e)} className="text-gray-400 hover:text-blue-600" aria-label={`Edit entry ${e.task}`}>Edit</button>
                      {confirmDeleteId === e.id ? (
                        <>
                          <span className="text-gray-500">Delete?</span>
                          <button onClick={() => deleteEntry(e)} className="font-medium text-red-600 hover:underline">Yes</button>
                          <button onClick={() => setConfirmDeleteId(null)} className="text-gray-400 hover:text-gray-600">No</button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(e.id)} className="text-gray-400 hover:text-red-600" aria-label={`Delete entry ${e.task}`}>✕</button>
                      )}
                    </span>
                  </div>
                  </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Breakdown */}
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">Time by activity</h2>
            <select
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
              value={chartProject}
              onChange={(e) => setChartProject(e.target.value)}
            >
              <option value="__all__">All projects</option>
              {knownProjects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="rounded-lg bg-white p-4 shadow-sm">
            {pieData.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-500">Track a little time and the breakdown appears here.</p>
            ) : (
              <>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                        {pieData.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="#fff" />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v, n) => [`${fmtHours(v)} · ${totalHours ? Math.round((v / totalHours) * 100) : 0}%`, n]} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-3 space-y-1.5">
                  {pieData.map((d, i) => (
                    <li key={d.name} className="flex items-center justify-between text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                        <span className="truncate">{d.name}</span>
                      </span>
                      <span className="mono text-xs text-gray-600">
                        {fmtHours(d.value)} · {totalHours ? Math.round((d.value / totalHours) * 100) : 0}%
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 border-t border-gray-100 pt-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Total time</span>
                    <span className="mono font-semibold">{fmtHours(totalHours)}</span>
                  </div>
                  {Object.entries(earningsByCurrency).map(([cur, amt]) => (
                    <div key={cur} className="mt-1 flex justify-between">
                      <span className="text-gray-500">Earned ({cur})</span>
                      <span className="mono font-semibold">{fmtMoney(amt, cur)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {invoiceOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h3 className="text-lg font-semibold">Export time by activity</h3>
              <button onClick={() => setInvoiceOpen(false)} className="text-gray-400 hover:text-gray-700" aria-label="Close">✕</button>
            </div>

            <div className="space-y-4 px-6 py-5">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Client</label>
                <select
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  value={invClient}
                  onChange={(e) => setInvClient(e.target.value)}
                >
                  {knownClients.length === 0 && <option value="">No clients yet</option>}
                  {knownClients.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Period start</label>
                  <input type="date" className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" value={invPeriodStart} onChange={(e) => setInvPeriodStart(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">Period end</label>
                  <input type="date" className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" value={invPeriodEnd} onChange={(e) => setInvPeriodEnd(e.target.value)} />
                </div>
              </div>

              {/* Live preview of what the export will contain */}
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
                {invoiceEntries.length === 0 ? (
                  <p className="text-sm text-gray-500">No entries for this client in the chosen period. Adjust the dates or pick another client.</p>
                ) : (
                  <div className="space-y-2 text-sm">
                    <p className="text-xs font-medium uppercase tracking-wider text-gray-400">This export will include</p>
                    {Object.entries(invoiceModel.projects).map(([proj, p]) => (
                      <div key={proj} className="flex justify-between">
                        <span className="text-gray-700">{proj} · {Object.keys(p.tasks).length} task{Object.keys(p.tasks).length > 1 ? "s" : ""}</span>
                        <span className="mono text-gray-600">{p.hours.toFixed(2)} h · {money(p.amount, invoiceModel.currencies[0])}</span>
                      </div>
                    ))}
                    <div className="mt-1 flex justify-between border-t border-gray-200 pt-2 font-semibold">
                      <span>Total billable</span>
                      <span className="mono">
                        {invoiceModel.grandHours.toFixed(2)} h · {invoiceModel.currencies.length > 1 ? "mixed currencies" : money(invoiceModel.grandAmount, invoiceModel.currencies[0])}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4">
              <button onClick={() => setInvoiceOpen(false)} className="rounded-md px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
              <button
                onClick={generateInvoicePdf}
                disabled={invoiceEntries.length === 0 || generating}
                className="rounded-md px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "#2C4BFF" }}
              >
                {generating ? "Preparing…" : "Export PDF"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
