import '../globals.css'

export const metadata = {
  title: 'Stratum · Playground',
}

export default function PlaygroundLayout({ children }) {
  return (
    <html lang="en">
      <body className="bg-app text-default h-screen overflow-hidden">
        {children}
      </body>
    </html>
  )
}
