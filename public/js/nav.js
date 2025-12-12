/********************************************************************
 *  NAV.JS — FINAL FIXED VERSION
 *  ✅ Allows homepage access for everyone
 *  ✅ Proper logout behavior
 *  ✅ Correct authentication checks
 ********************************************************************/

/* ================================================================
   DISABLED NAV PAGES
================================================================ */
const DISABLED = [
    "/unsubscribe.html",
    "/success.html",
    "/cancel.html",
    "/reset_password.html",
    "/forgot_password.html",
    "/reset_request.html"
];

if (DISABLED.includes(window.location.pathname)) {
    window.SKIP_NAV_JS = true;
}

if (window.SKIP_NAV_JS === true) {
    console.log("⛔ nav.js disabled on this page");
    throw new Error("NAV_DISABLED");
}

/* ================================================================
   HELPER — API
================================================================ */
async function api(path, options = {}) {
    try {
        const res = await fetch(path, {
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            ...options
        });
        return await res.json();
    } catch {
        return null;
    }
}

/* ================================================================
   AUTH HELPERS
================================================================ */
async function getCustomer() {
    try {
        const res = await fetch("/api/customer/me", {
            credentials: "include",
            cache: "no-store"
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.customer || null;
    } catch {
        return null;
    }
}

async function getAdmin() {
    try {
        const res = await fetch("/api/admin/me", {
            credentials: "include",
            cache: "no-store"
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data.admin?.role === "admin";
    } catch {
        return false;
    }
}

/* ================================================================
   CART COUNT
================================================================ */
async function getCartCount() {
    try {
        const d = await api("/api/cart");
        return Array.isArray(d?.items) ? d.items.length : 0;
    } catch {
        return 0;
    }
}

/* ================================================================
   NAV ELEMENT
================================================================ */
function ensureNavbarEl() {
    let el = document.getElementById("navbar");
    if (!el) {
        el = document.createElement("div");
        el.id = "navbar";
        document.body.prepend(el);
    }
    return el;
}

/* ================================================================
   GLOBAL NAV STYLES
================================================================ */
(function injectStyles() {
    const s = document.createElement("style");
    s.innerHTML = `
        #navbar {
            position: fixed;
            top: 0;
            width: 100%;
            padding: 18px 0;
            background: rgba(255,255,255,0.7);
            backdrop-filter: blur(20px);
            box-shadow: 0 2px 12px rgba(0,0,0,0.06);
            z-index: 9999;
        }
        .nav-inner {
            max-width: 1200px;
            margin: auto;
            padding: 0 28px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .nav-logo {
            font-size: 20px;
            font-weight: 900;
            color: #d6336c;
            cursor: pointer;
        }
        .nav-links a {
            margin-left: 22px;
            text-decoration: none;
            font-weight: 500;
            color: #1a1a1a;
            position: relative;
        }
        .nav-links a:hover {
            color: #d6336c;
        }
        .cart-bubble {
            position: absolute;
            top: -10px;
            right: -12px;
            background: #d6336c;
            color: white;
            padding: 2px 7px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 700;
        }
    `;
    document.head.appendChild(s);
})();

/* ================================================================
   NAV LAYOUTS
================================================================ */
function publicNav() {
    return `
        <div class="nav-inner">
            <div class="nav-logo" onclick="window.location.href='/index.html'">LOVETEXTFORHER</div>
            <div class="nav-links">
                <a href="/index.html">Home</a>
                <a href="/products.html">Plans</a>
                <a href="/login.html">Login</a>
                <a href="/register.html">Sign Up</a>
            </div>
        </div>`;
}

function customerNav(cartBubble) {
    return `
        <div class="nav-inner">
            <div class="nav-logo" onclick="window.location.href='/dashboard.html'">LOVETEXTFORHER</div>
            <div class="nav-links">
                <a href="/index.html">Home</a>
                <a href="/dashboard.html">Dashboard</a>
                <a href="/products.html">Plans</a>
                <a href="/cart.html">Cart ${cartBubble}</a>
                <a href="#" id="logout-customer">Logout</a>
            </div>
        </div>`;
}

function adminNav() {
    return `
        <div class="nav-inner">
            <div class="nav-logo" onclick="window.location.href='/admin.html'">ADMIN PANEL</div>
            <div class="nav-links">
                <a href="/admin.html">Dashboard</a>
                <a href="/admin_users.html">Users</a>
                <a href="/admin_customers.html">Customers</a>
                <a href="/admin_kpis.html">KPIs</a>
                <a href="#" id="logout-admin">Logout</a>
            </div>
        </div>`;
}

/* ================================================================
   LOGOUT HANDLERS
================================================================ */
async function logoutCustomer() {
    try {
        await api("/api/customer/logout", { method: "POST" });
        // Clear any cached data
        sessionStorage.clear();
        // Redirect to login
        window.location.href = "/login.html";
    } catch (err) {
        console.error("Logout error:", err);
        window.location.href = "/login.html";
    }
}

async function logoutAdmin() {
    try {
        await api("/api/admin/logout", { method: "POST" });
        // Clear any cached data
        sessionStorage.clear();
        // Redirect to admin login
        window.location.href = "/admin_login.html";
    } catch (err) {
        console.error("Admin logout error:", err);
        window.location.href = "/admin_login.html";
    }
}

/* ================================================================
   INJECT NAVBAR
================================================================ */
async function injectNavbar() {
    const navbar = ensureNavbarEl();
    navbar.innerHTML = "";

    const path = window.location.pathname;

    const customer = await getCustomer();
    const admin = await getAdmin();

    console.log("🔍 Current Path:", path);
    console.log("👤 Customer:", customer ? "Logged in" : "Not logged in");
    console.log("👨‍💼 Admin:", admin ? "Logged in" : "Not logged in");

    // Admin pages
    if (admin && path.startsWith("/admin") && path !== "/admin_login.html") {
        navbar.innerHTML = adminNav();
        const logoutBtn = document.getElementById("logout-admin");
        if (logoutBtn) logoutBtn.onclick = logoutAdmin;
        return;
    }

    // Customer pages (protected routes that need authentication)
    const customerProtectedPages = [
        "/dashboard.html",
        "/cart.html"
    ];

    // Show customer nav if logged in AND on customer pages OR homepage/products
    if (customer && (customerProtectedPages.includes(path) || path === "/index.html" || path === "/" || path === "/products.html")) {
        const count = await getCartCount();
        const bubble = count > 0 ? `<span class="cart-bubble">${count}</span>` : "";
        navbar.innerHTML = customerNav(bubble);
        const logoutBtn = document.getElementById("logout-customer");
        if (logoutBtn) logoutBtn.onclick = logoutCustomer;
        return;
    }

    // Default public nav for everyone else
    navbar.innerHTML = publicNav();
}

/* ================================================================
   ACCESS CONTROL - ONLY PROTECT TRULY PROTECTED PAGES
================================================================ */
async function enforceAccess() {
    const path = window.location.pathname;

    const customer = await getCustomer();
    const admin = await getAdmin();

    // Pages that EVERYONE can access (public pages)
    const publicPages = [
        "/index.html",
        "/",
        "/products.html",
        "/login.html",
        "/register.html",
        "/forgot_password.html",
        "/reset_password.html"
    ];

    // Don't enforce access on public pages
    if (publicPages.includes(path)) {
        return; // Allow access
    }

    // Pages that REQUIRE customer login
    const customerProtected = [
        "/dashboard.html",
        "/cart.html"
    ];

    // Pages that REQUIRE admin login
    const adminProtected = [
        "/admin.html",
        "/admin_users.html",
        "/admin_customers.html",
        "/admin_kpis.html"
    ];

    // CUSTOMER PAGE WITHOUT LOGIN → Redirect to login
    if (customerProtected.includes(path) && !customer) {
        console.log("🚫 Not logged in, redirecting to login");
        return (window.location.href = "/login.html");
    }

    // ADMIN PAGE WITHOUT LOGIN → Redirect to admin login
    if (adminProtected.includes(path) && !admin) {
        console.log("🚫 Not admin, redirecting to admin login");
        return (window.location.href = "/admin_login.html");
    }

    // If customer is on login/register, redirect to dashboard
    if (customer && (path === "/login.html" || path === "/register.html")) {
        console.log("✅ Already logged in, redirecting to dashboard");
        return (window.location.href = "/dashboard.html");
    }

    // If admin is on admin_login, redirect to admin dashboard
    if (admin && path === "/admin_login.html") {
        console.log("✅ Already logged in as admin, redirecting to admin dashboard");
        return (window.location.href = "/admin.html");
    }
}

/* ================================================================
   INIT
================================================================ */
document.addEventListener("DOMContentLoaded", async () => {
    await injectNavbar();
    await enforceAccess();
});