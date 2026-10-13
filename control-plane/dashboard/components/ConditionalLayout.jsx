'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

const NO_SIDEBAR_PATHS = ['/login', '/prompt']

export default function ConditionalLayout({ children }) {
  const path = usePathname()
  const noSidebar = NO_SIDEBAR_PATHS.some(p => path === p || path.startsWith(p + '/'))

  if (noSidebar) {
    return (
      <div className="h-screen bg-app text-default flex flex-col">
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
