import { syncClerkUser } from '../../../lib/sync-user'

export default async function DashboardPage() {
  const user = await syncClerkUser()

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-gray-600">
        Welcome back{user?.name ? `, ${user.name}` : ''}. Here is your overview.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
        {['Total Users', 'Monthly Revenue', 'Active Subscriptions'].map((metric) => (
          <div key={metric} className="rounded-lg bg-white p-6 shadow">
            <p className="text-sm font-medium text-gray-600">{metric}</p>
            <p className="mt-2 text-3xl font-bold text-gray-900">—</p>
          </div>
        ))}
      </div>
    </div>
  )
}
