import { graphql, type ResultOf } from "gql.tada";
import { cn } from "cnfast";
import { useQuery } from "urql";
import { CalendarIcon, LoadingIcon } from "../components/icons";

// ============================================================================
// GraphQL
// ============================================================================

// RBAC scopes rows to the logged-in user's org.
const DashboardQuery = graphql(`
  query Dashboard {
    tasks: public_tasks(where: { status: { neq: "done" } }, orderBy: [{ priority: DESC }]) {
      id
      title
      status
      priority
      due_date
      is_overdue
      age_days
    }
  }
`);

type DashboardQueryReturn = ResultOf<typeof DashboardQuery>;
type Task = DashboardQueryReturn["tasks"][number];

// ============================================================================
// Components
// ============================================================================

const statusStyles: Record<string, string> = {
  todo: "bg-gray-700 text-gray-200",
  in_progress: "bg-blue-900/50 text-blue-300",
  done: "bg-green-900/50 text-green-300",
};

const StatusPill = ({ status }: { status: string }) => (
  <span
    className={cn(
      "px-2 py-0.5 rounded text-xs font-medium",
      statusStyles[status] ?? "bg-gray-700 text-gray-200",
    )}
  >
    {status.replace("_", " ")}
  </span>
);

const TaskCard = ({ task }: { task: Task }) => (
  <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-start justify-between gap-4">
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1.5">
        <h3 className="text-white font-medium truncate">{task.title}</h3>
        {task.is_overdue && (
          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/20">
            Overdue
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <StatusPill status={task.status} />
        {task.due_date && (
          <span className="flex items-center gap-1">
            <CalendarIcon className="w-3.5 h-3.5" />
            {new Date(task.due_date).toLocaleDateString()}
          </span>
        )}
        <span>{task.age_days}d old</span>
      </div>
    </div>
    <div className="shrink-0 text-right">
      <div className="text-xs text-gray-500">Priority</div>
      <div className="text-2xl font-bold text-white">{task.priority}</div>
    </div>
  </div>
);

// ============================================================================
// Page
// ============================================================================

export const DashboardPage = () => {
  const [{ data, fetching, error }] = useQuery({ query: DashboardQuery });

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-1">Dashboard</h1>
      <p className="text-gray-400 text-sm mb-6">Open tasks, highest priority first</p>

      {fetching && (
        <div className="flex items-center justify-center py-24">
          <LoadingIcon className="w-6 h-6 text-gray-400" />
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error.message}
        </div>
      )}

      {!fetching && !error && (
        <div className="space-y-3">
          {data!.tasks.length === 0 ? (
            <p className="text-gray-500 text-sm">No open tasks.</p>
          ) : (
            data!.tasks.map((task) => <TaskCard key={task.id} task={task} />)
          )}
        </div>
      )}
    </div>
  );
};
