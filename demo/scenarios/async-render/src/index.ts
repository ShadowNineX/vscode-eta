import { Eta } from "eta";
import path from "node:path";

const eta = new Eta({
  views: path.join(import.meta.dirname, "../views"),
});

type AsyncReportRow = {
  label: string;
  value: number;
  trend: "up" | "down" | "flat";
};

type AsyncReport = {
  title: string;
  generatedBy: string;
  rows: AsyncReportRow[];
  fetchSummary: () => Promise<string>;
};

const report: AsyncReport = {
  title: "Async Operations",
  generatedBy: "Eta demo",
  rows: [
    { label: "Jobs completed", value: 128, trend: "up" },
    { label: "Retries", value: 4, trend: "down" },
  ],
  fetchSummary: async () => "All async jobs completed successfully.",
};

console.log(await eta.renderAsync("async-report", report));
console.log(await eta.renderAsync("async-line", { row: report.rows[0] }));
