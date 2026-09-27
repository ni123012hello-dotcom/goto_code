import { createRoot } from "react-dom/client"
import App from "./App"
import SessionsWindow from "./components/SessionsWindow"
import { initToken } from "./auth"
import "./index.css"

// before anything renders: every request and every EventSource needs the seat token, and the
// only chance to read it out of the URL fragment is before the router touches the address bar
initToken()

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root element")

const isSessionsWindow = new URLSearchParams(window.location.search).get("window") === "sessions"
if (isSessionsWindow) document.title = "goto · 会话"

createRoot(container).render(isSessionsWindow ? <SessionsWindow /> : <App />)
