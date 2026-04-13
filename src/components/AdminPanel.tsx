"use client";

import { useState, useEffect, useCallback } from "react";

interface User {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: string;
  created_at: string;
}

export default function AdminPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      setUsers(await res.json());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const addUser = async () => {
    setError("");
    if (!newEmail) {
      setError("メールアドレスを入力してください");
      return;
    }
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, name: newName, role: newRole }),
    });
    if (res.ok) {
      setNewEmail("");
      setNewName("");
      setNewRole("user");
      fetchUsers();
    } else {
      const data = await res.json();
      setError(data.error || "エラーが発生しました");
    }
  };

  const updateRole = async (userId: string, role: string) => {
    await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId, role }),
    });
    fetchUsers();
  };

  const deleteUser = async (userId: string) => {
    if (!confirm("このユーザーを削除しますか？")) return;
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId }),
    });
    if (res.ok) {
      fetchUsers();
    } else {
      const data = await res.json();
      setError(data.error || "エラーが発生しました");
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="mb-4 text-lg font-semibold">ユーザー管理</h2>

      {/* Add user form */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-700">
          新しいユーザーを追加
        </h3>
        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            placeholder="メールアドレス"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="名前 (任意)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-40 rounded border border-gray-300 px-3 py-2 text-sm"
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="user">一般ユーザー</option>
            <option value="admin">管理者</option>
          </select>
          <button
            onClick={addUser}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            追加
          </button>
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-600">{error}</p>
        )}
      </div>

      {/* Users list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        {loading ? (
          <div className="p-4 text-center text-gray-400">読み込み中...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="p-3 font-medium">ユーザー</th>
                <th className="p-3 font-medium">メール</th>
                <th className="p-3 font-medium">役割</th>
                <th className="p-3 font-medium">作成日</th>
                <th className="p-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-gray-100">
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      {user.image && (
                        <img
                          src={user.image}
                          alt=""
                          className="h-6 w-6 rounded-full"
                        />
                      )}
                      {user.name || "-"}
                    </div>
                  </td>
                  <td className="p-3 text-gray-600">{user.email}</td>
                  <td className="p-3">
                    <select
                      value={user.role}
                      onChange={(e) => updateRole(user.id, e.target.value)}
                      className="rounded border border-gray-200 px-2 py-1 text-xs"
                    >
                      <option value="user">一般ユーザー</option>
                      <option value="admin">管理者</option>
                    </select>
                  </td>
                  <td className="p-3 text-gray-500">
                    {user.created_at?.split("T")[0] || user.created_at}
                  </td>
                  <td className="p-3">
                    <button
                      onClick={() => deleteUser(user.id)}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
