import './globals.css'
import ConditionalLayout from '../components/ConditionalLayout'

export const metadata = {
  title: 'Stratum',
  description: 'Consola de Stratum',
}

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <ConditionalLayout>
          {children}
        </ConditionalLayout>
      </body>
    </html>
  )
}
