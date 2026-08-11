'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

export default function ConditionalLayout({ children }) {
  const path = usePathname()
  const noSidebar = path === '/login'

  if (noSidebar) {
    return (
      <div className="min-h-screen bg-app text-default">
        {children}
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-app text-default">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
