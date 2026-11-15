"use strict";

function minutesBetween(start, end) {
  if (!/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "")) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const from = sh * 60 + sm, to = eh * 60 + em;
  if (sh > 23 || eh > 23 || sm > 59 || em > 59 || to < from) return 0;
  return Math.max(0, to - from);
}

function buildDailyReportAnalytics(reports) {
  if (!Array.isArray(reports)) throw new Error("Reports must be an array");
  const siteCounts = new Map();
  const dateCounts = new Map();
  const equipmentCounts = new Map();
  let workerDays = 0, estimatedPersonHours = 0, validTimeReports = 0;
  for (const report of reports) {
    const site = String(report.siteName || "").trim() || "現場未設定";
    siteCounts.set(site, (siteCounts.get(site) || 0) + 1);
    dateCounts.set(report.workDate, (dateCounts.get(report.workDate) || 0) + 1);
    const people = Number.isFinite(report.workerCount) && report.workerCount > 0 ? report.workerCount : 0;
    workerDays += people;
    const duration = minutesBetween(report.startTime, report.endTime);
    const pause = Number.isFinite(report.breakMinutes) && report.breakMinutes >= 0 ? report.breakMinutes : 0;
    if (duration > 0 && duration >= pause) {
      estimatedPersonHours += ((duration - pause) / 60) * people;
      validTimeReports += 1;
    }
    for (const item of String(report.equipment || "").split(/[、,，/]/).map(x => x.trim()).filter(Boolean)) {
      equipmentCounts.set(item, (equipmentCounts.get(item) || 0) + 1);
    }
  }
  const top = map => [...map.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,10).map(([name,count])=>({name,count}));
  const workDates = [...dateCounts.entries()].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,14).map(([date,count])=>({date,reportCount:count}));
  return {
    reportCount: reports.length,
    siteCount: siteCounts.size,
    workerDays,
    estimatedPersonHours: Math.round(estimatedPersonHours * 10) / 10,
    validTimeReports,
    topSites: top(siteCounts),
    topEquipment: top(equipmentCounts),
    recentWorkDates: workDates,
    dataScope: "取得できた最大99件の日報サンプル。全期間の確定集計ではありません。"
  };
}

module.exports = { buildDailyReportAnalytics };
