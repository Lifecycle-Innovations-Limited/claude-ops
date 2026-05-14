import Link from 'next/link'
import { UserButton } from '@clerk/nextjs'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-white shadow-sm">
        <div className="flex items-center justify-between p-6">
          <h2 className="text-xl font-semibold">SaaS App</h2>
          <UserButton afterSignOutUrl="/" />
        </div>
        <nav className="mt-4 px-4">
          <Link
            href="/dashboard"
            className="block rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-100"
          >
            Dashboard
          </Link>
          <Link
            href="/dashboard/settings"
            className="block rounded-lg px-4 py-2 text-gray-700 hover:bg-gray-100"
          >
            Settings
          </Link>
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-8">{children}</main>
    </div>
  )
}
