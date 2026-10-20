import { useParams } from "@tanstack/react-router";
import { useReport } from "./queries";
import { ReportView } from "./ReportView";

export function ReportPage() {
  const { reportId } = useParams({ strict: false }) as { reportId: string };
  const { data, isLoading, error, refetch } = useReport(reportId);
  if (isLoading)
    return (
      <p className="p-6" aria-busy="true">
        Loading report...
      </p>
    );
  if (error) {
    return (
      <p className="p-6" role="alert">
        The report could not be loaded.{" "}
        <button type="button" className="min-h-11 underline" onClick={() => refetch()}>
          Retry
        </button>
      </p>
    );
  }
  if (!data) return <p className="p-6">This report does not exist or is not available to you.</p>;
  return <ReportView data={data} />;
}
