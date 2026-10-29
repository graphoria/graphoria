import { Fragment, useState } from "react";

import type { UserRolesResponse, UsersResponse } from "../client";

import { apiDelete, apiPatch, apiPost } from "../client";
import { generatePassword } from "../password";
import { useApi } from "../useApi";
import { useDebounced } from "../useDebounced";

const SEARCH_DEBOUNCE_MS = 250;

const CreateUserForm = ({ roles, onCreated }: { roles: string[]; onCreated: () => void }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [role, setRole] = useState(roles[0] ?? "");
  const [claims, setClaims] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      let parsedClaims: unknown;
      if (claims.trim()) {
        try {
          parsedClaims = JSON.parse(claims);
        } catch {
          throw new Error("Claims must be valid JSON");
        }
      }
      const name = username.trim();
      await apiPost<{ ok: boolean }>("/users", {
        username: name,
        password,
        role,
        ...(parsedClaims === undefined ? {} : { claims: parsedClaims }),
      });
      setResult(`Created ${name} (${role}).`);
      setUsername("");
      setPassword("");
      setShown(false);
      setClaims("");
      onCreated();
    } catch (error) {
      setResult((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 max-w-xl">
      <input
        className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
        placeholder="username"
        autoComplete="off"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <div className="flex gap-2 items-center">
        <input
          className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-mono"
          type={shown ? "text" : "password"}
          placeholder="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={() => {
            setPassword(generatePassword());
            setShown(true);
          }}
        >
          Generate
        </button>
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {shown && password && (
        <p className="text-xs text-gray-400">
          Copy the password before you create the user: the console cannot show it again.
        </p>
      )}
      <select
        className="border border-gray-200 rounded px-2 py-1 text-sm"
        value={role}
        onChange={(event) => setRole(event.target.value)}
      >
        {roles.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <textarea
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm font-mono"
        rows={3}
        placeholder='claims, optional: {"organizationId": 42}'
        value={claims}
        onChange={(event) => setClaims(event.target.value)}
      />
      <button
        type="submit"
        className="self-start text-sm bg-gray-900 text-white rounded px-3 py-1 cursor-pointer disabled:opacity-50"
        disabled={saving || !username.trim() || !password}
      >
        {saving ? "Creating…" : "Create user"}
      </button>
      {result && <p className="text-sm text-gray-500">{result}</p>}
    </form>
  );
};

const NewUser = ({ onCreated }: { onCreated: () => void }) => {
  const { data, error, loading } = useApi<UserRolesResponse>("/users/roles");

  if (loading) return <p className="text-gray-400">Loading…</p>;
  if (error) return <p className="text-red-500">{error}</p>;
  if (data!.roles.length === 0)
    return (
      <p className="text-gray-400">
        No role can be assigned here: add one under auth.permissions. Superadmin users are created
        with graphoria seed-auth.
      </p>
    );

  return <CreateUserForm roles={data!.roles} onCreated={onCreated} />;
};

type UsersQuery = { search: string; role: string; page: number };

type UserRow = UsersResponse["users"][number];

type RowFormKind = "edit" | "password";

const EditUserForm = ({
  user,
  roles,
  onSaved,
  onCancel,
}: {
  user: UserRow;
  roles: string[];
  onSaved: () => void;
  onCancel: () => void;
}) => {
  const [role, setRole] = useState(user.role);
  const [claims, setClaims] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setResult(null);
    let parsedClaims: unknown = {};
    if (claims.trim()) {
      try {
        parsedClaims = JSON.parse(claims);
      } catch {
        setResult("Claims must be valid JSON");
        return;
      }
    }
    setSaving(true);
    try {
      await apiPatch<{ ok: boolean }>("/users", {
        username: user.username,
        role,
        claims: parsedClaims,
      });
      setResult(`Saved ${user.username}.`);
      onSaved();
    } catch (error) {
      setResult((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 max-w-xl">
      <p className="text-sm text-gray-500 font-mono">{user.username}</p>
      <select
        aria-label="Role"
        className="border border-gray-200 rounded px-2 py-1 text-sm"
        value={role}
        onChange={(event) => setRole(event.target.value)}
      >
        {roles.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <textarea
        className="w-full border border-gray-200 rounded px-2 py-1 text-sm font-mono"
        rows={3}
        placeholder='claims, replaces the current ones: {"organizationId": 42}'
        value={claims}
        onChange={(event) => setClaims(event.target.value)}
      />
      <div className="flex gap-3 items-center">
        <button
          type="submit"
          className="text-sm bg-gray-900 text-white rounded px-3 py-1 cursor-pointer disabled:opacity-50"
          disabled={saving || !role}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {result && <p className="text-sm text-gray-500">{result}</p>}
    </form>
  );
};

const ResetPasswordForm = ({
  username,
  onSaved,
  onCancel,
}: {
  username: string;
  onSaved: () => void;
  onCancel: () => void;
}) => {
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setResult(null);
    try {
      await apiPost<{ ok: boolean }>("/users/password", { username, password });
      setPassword("");
      setShown(false);
      setResult(`Password reset for ${username}.`);
      onSaved();
    } catch (error) {
      setResult((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 max-w-xl">
      <p className="text-sm text-gray-500 font-mono">{username}</p>
      <div className="flex gap-2 items-center">
        <input
          className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm font-mono"
          type={shown ? "text" : "password"}
          placeholder="new password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={() => {
            setPassword(generatePassword());
            setShown(true);
          }}
        >
          Generate
        </button>
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {shown && password && (
        <p className="text-xs text-gray-400">
          Copy the password before you save it: the console cannot show it again.
        </p>
      )}
      <div className="flex gap-3 items-center">
        <button
          type="submit"
          className="text-sm bg-gray-900 text-white rounded px-3 py-1 cursor-pointer disabled:opacity-50"
          disabled={saving || !password}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {result && <p className="text-sm text-gray-500">{result}</p>}
    </form>
  );
};

const UserActions = ({
  user,
  onOpen,
  onChanged,
}: {
  user: UserRow;
  onOpen: (kind: RowFormKind) => void;
  onChanged: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!window.confirm(`Delete ${user.username}? This cannot be undone.`)) return;
    void run(() =>
      apiDelete<{ ok: boolean }>(`/users?username=${encodeURIComponent(user.username)}`),
    );
  };

  return (
    <span className="flex gap-2 items-center">
      <button
        type="button"
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
        onClick={() => onOpen("edit")}
      >
        Edit
      </button>
      <button
        type="button"
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
        disabled={busy}
        onClick={() =>
          void run(() =>
            apiPost("/users/active", { username: user.username, isActive: !user.isActive }),
          )
        }
      >
        {user.isActive ? "Deactivate" : "Activate"}
      </button>
      <button
        type="button"
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer"
        onClick={() => onOpen("password")}
      >
        Reset password
      </button>
      <button
        type="button"
        className="text-sm text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
        disabled={busy}
        onClick={remove}
      >
        Delete
      </button>
      {error && <span className="text-red-500 text-xs">{error}</span>}
    </span>
  );
};

const UsersTable = ({
  data,
  page,
  filtered,
  readOnly,
  onPage,
  onChanged,
}: {
  data: UsersResponse;
  page: number;
  filtered: boolean;
  readOnly: boolean;
  onPage: (page: number) => void;
  onChanged: () => void;
}) => {
  const [open, setOpen] = useState<{ username: string; kind: RowFormKind } | null>(null);

  if (data.total === 0)
    return <p className="text-gray-400">{filtered ? "No user matches." : "No users yet."}</p>;

  const pages = Math.ceil(data.total / data.pageSize);

  const toggle = (username: string, kind: RowFormKind) =>
    setOpen((current) =>
      current?.username === username && current.kind === kind ? null : { username, kind },
    );

  return (
    <>
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200">
          <tr>
            <th className="text-left py-2 pr-2 text-gray-500 font-medium">Username</th>
            <th className="text-left py-2 pr-2 text-gray-500 font-medium">Role</th>
            <th className="text-left py-2 pr-2 text-gray-500 font-medium">State</th>
            {!readOnly && (
              <th className="text-left py-2 pr-2 text-gray-500 font-medium">Actions</th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.users.map((user) => (
            <Fragment key={user.username}>
              <tr className="border-b border-gray-100">
                <td className="font-mono text-sm py-1.5 pr-2">{user.username}</td>
                <td className="py-1.5 pr-2">{user.role}</td>
                <td className="py-1.5 pr-2">
                  <span
                    className={
                      user.isActive
                        ? "inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5"
                        : "inline-block w-2 h-2 rounded-full bg-red-500 mr-1.5"
                    }
                  />
                  {user.isActive ? "active" : "inactive"}
                </td>
                {!readOnly && (
                  <td className="py-1.5 pr-2">
                    <UserActions
                      user={user}
                      onOpen={(kind) => toggle(user.username, kind)}
                      onChanged={onChanged}
                    />
                  </td>
                )}
              </tr>
              {open?.username === user.username && (
                <tr className="border-b border-gray-100">
                  <td colSpan={readOnly ? 3 : 4} className="py-2 bg-gray-50 px-2">
                    {open.kind === "edit" ? (
                      <EditUserForm
                        user={user}
                        roles={data.roles}
                        onSaved={onChanged}
                        onCancel={() => setOpen(null)}
                      />
                    ) : (
                      <ResetPasswordForm
                        username={user.username}
                        onSaved={onChanged}
                        onCancel={() => setOpen(null)}
                      />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="flex gap-3 items-center mt-2 text-sm">
        <button
          type="button"
          className="text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <span className="text-gray-400">
          Page {page} of {pages} · {data.total} {data.total === 1 ? "user" : "users"}
        </span>
        <button
          type="button"
          className="text-gray-500 hover:text-gray-900 cursor-pointer disabled:opacity-50"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </>
  );
};

const UsersList = ({
  query,
  readOnly,
  onQuery,
  onChanged,
}: {
  query: UsersQuery;
  readOnly: boolean;
  onQuery: (query: UsersQuery) => void;
  onChanged: () => void;
}) => {
  const search = useDebounced(query.search.trim(), SEARCH_DEBOUNCE_MS);
  const { data, error, loading } = useApi<UsersResponse>(
    `/users?${new URLSearchParams({ search, role: query.role, page: String(query.page) })}`,
  );

  return (
    <>
      <div className="flex gap-2 mb-2">
        <input
          className="border border-gray-200 rounded px-2 py-1 text-sm font-mono"
          placeholder="search"
          maxLength={50}
          value={query.search}
          onChange={(event) => onQuery({ ...query, search: event.target.value, page: 1 })}
        />
        <select
          aria-label="Filter by role"
          className="border border-gray-200 rounded px-2 py-1 text-sm"
          value={query.role}
          onChange={(event) => onQuery({ ...query, role: event.target.value, page: 1 })}
        >
          <option value="">all roles</option>
          {data?.roles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {loading && <p className="text-gray-400">Loading…</p>}
      {error && <p className="text-red-500">{error}</p>}
      {!loading && data && (
        <UsersTable
          data={data}
          page={query.page}
          filtered={search !== "" || query.role !== ""}
          readOnly={readOnly}
          onPage={(page) => onQuery({ ...query, page })}
          onChanged={onChanged}
        />
      )}
    </>
  );
};

export const UsersPage = ({ readOnly }: { readOnly: boolean }) => {
  const [query, setQuery] = useState<UsersQuery>({ search: "", role: "", page: 1 });
  // A new key remounts the list, which then reads its page again.
  const [listVersion, setListVersion] = useState(0);

  return (
    <>
      <h1 className="text-xl font-bold mb-4">Users</h1>
      {!readOnly && (
        <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
          <h2 className="text-lg font-semibold mb-2">New user</h2>
          <NewUser onCreated={() => setListVersion((version) => version + 1)} />
        </div>
      )}
      <div className="bg-white rounded-lg shadow-sm p-4 mb-3">
        <h2 className="text-lg font-semibold mb-2">Existing users</h2>
        <UsersList
          key={listVersion}
          query={query}
          readOnly={readOnly}
          onQuery={setQuery}
          onChanged={() => setListVersion((version) => version + 1)}
        />
      </div>
    </>
  );
};
