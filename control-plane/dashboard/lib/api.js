// Wrapper for dashboard API calls that handles session expiry gracefully
export async function dashboardFetch(url, options = {}) {
  const res = await fetch(url, options)

  // No session (expired, revoked or signed out): back to the sign-in page.
  // A 403 is a permission answer for this request, not a lost session.
  if (res.status === 401) {
    window.location.replace('/login?reason=session_expired')
    return null
  }

  return res
}
