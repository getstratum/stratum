// Wrapper for dashboard API calls that handles session expiry gracefully
export async function dashboardFetch(url, options = {}) {
  const res = await fetch(url, options)

  // Session expired or invalid — redirect to login
  if (res.status === 401 || res.status === 403) {
    window.location.replace('/login?reason=session_expired')
    return null
  }

  return res
}
