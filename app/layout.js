import './globals.css'

export const metadata = {
  title: 'Ashveil',
  description: 'Intelligent Debt Recovery Platform',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
