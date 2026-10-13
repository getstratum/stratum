import './globals.css'
import ConditionalLayout from '../components/ConditionalLayout'

export const metadata = {
  title: 'Stratum',
  description: 'Stratum AI Governance',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ConditionalLayout>
          {children}
        </ConditionalLayout>
      </body>
    </html>
  )
}
