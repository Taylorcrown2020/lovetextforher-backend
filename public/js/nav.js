/********************************************************************
 *  NAV.JS — FINAL PRODUCTION VERSION  
 *  Fully compatible with the new server, DB, and HTML pages.
 ********************************************************************/

// ================================================================
// PAGES THAT REQUIRE NAV TO BE DISABLED
// ================================================================
const PAGES_THAT_DISABLE_NAV = [
    "/forgot.html",
    "/reset_request.html",
    "/reset.html",
    "/unsubscribe.html",
    "/success.html",
    "/cancel.html"
];

if (PAGES_THAT_DISABLE_NAV.includes(window.location.pathname)) {
    window.SKIP_NAV_JS = true;
}

if (window.SKIP_NAV_JS === true) {
    console.log("⛔ nav.js disabled for this page");
    throw new Error("NAV_JS_DISABLED");
}

// ================================================================
// HELPERS — API + AUTH CHECKS
// ================================================================
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
        return {};
    }
}

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

// ================================================================
// CART COUNT
// ================================================================
async function getCartCount() {
    try {
        const d = await api("/api/cart");
        return Array.isArray(d.items) ? d.items.length : 0;
    } catch {
        return 0;
    }
}

// ================================================================
// NAVBAR ELEMENT
// ================================================================
function ensureNavbarEl() {
    let el = document.getElementById("navbar");
    if (!el) {
        el = document.createElement("div");
        el.id = "navbar";
        document.body.prepend(el);
    }
    return el;
}

// ================================================================
// INJECT GLOBAL NAVBAR STYLES (FIXED — no more .innerHTML wipe!!!)
// ================================================================
(function injectGlobalNavStyles() {
    const style = document.createElement("style");
    style.innerHTML = `
        #navbar {
            position: fixed;
            top: 0;
            width: 100%;
            padding: 18px 0;
            background: rgba(255,255,255,0.75);
            backdrop-filter: blur(18px);
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
    document.head.appendChild(style);
})();

// ================================================================
// NAVBAR HTML BLOCKS
// ================================================================
function publicNav() {
    return `
        <div class="nav-inner">
            <div class="nav-logo">LOVETEXTFORHER</div>
            <div class="nav-links">
                <a href="/index.html">Home</a>
                <a href="/login.html">Login</a>
                <a href="/register.html">Register</a>
                <a href="/admin_login.html">Admin</a>
            </div>
        </div>`;
}

function customerNav(cartBubble) {
    return `
        <div class="nav-inner">
            <div class="nav-logo">LOVETEXTFORHER</div>
            <div class="nav-links">
                <a href="/dashboard.html">Dashboard</a>
                <a href="/products.html">Products</a>
                <a href="/cart.html">Cart ${cartBubble}</a>
                <a href="#" id="logout-customer">Logout</a>
            </div>
        </div>`;
}

function adminNav() {
    return `
        <div class="nav-inner">
            <div class="nav-logo">ADMIN PANEL</div>
            <div class="nav-links">
                <a href="/admin.html">Dashboard</a>
                <a href="/admin_users.html">Users</a>
                <a href="/admin_customers.html">Customers</a>
                <a href="/admin_kpis.html">KPIs</a>
                <a href="#" id="logout-admin">Logout</a>
            </div>
        </div>`;
}

// ================================================================
// LOGOUT HANDLERS
// ================================================================
async function logoutCustomer() {
    await api("/api/customer/logout", { method: "POST" });
    window.location.href = "/login.html";
}

async function logoutAdmin() {
    await api("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin_login.html";
}

// ================================================================
// INJECT NAVBAR (DYNAMIC)
// ================================================================
async function injectNavbar() {
    const navbar = ensureNavbarEl();
    navbar.innerHTML = ""; // only remove previous inject, NOT styles

    const path = window.location.pathname;

    const customer = await getCustomer();
    const admin = await getAdmin();

    // Admin pages
    if (admin && path.startsWith("/admin") && path !== "/admin_login.html") {
        navbar.innerHTML = adminNav();
        document.getElementById("logout-admin").onclick = logoutAdmin;
        return;
    }

    // Customer pages
    if (customer && ["/dashboard.html", "/products.html", "/cart.html"].includes(path)) {
        const count = await getCartCount();
        const bubble = count > 0 ? `<span class="cart-bubble">${count}</span>` : "";
        navbar.innerHTML = customerNav(bubble);
        document.getElementById("logout-customer").onclick = logoutCustomer;
        return;
    }

    // Default public nav
    navbar.innerHTML = publicNav();
}

// ================================================================
// ACCESS CONTROL RULES
// ================================================================
async function enforceAccess() {
    const path = window.location.pathname;

    const customer = await getCustomer();
    const admin = await getAdmin();

    // CUSTOMER LOGIN REQUIRED
    const customerProtected = [
        "/dashboard.html",
        "/products.html",
        "/cart.html"
    ];

    if (customerProtected.includes(path) && !customer) {
        return (window.location.href = "/login.html");
    }

    // ADMIN LOGIN REQUIRED
    const adminProtected = [
        "/admin.html",
        "/admin_users.html",
        "/admin_customers.html",
        "/admin_kpis.html"
    ];

    if (adminProtected.includes(path) && !admin) {
        return (window.location.href = "/admin_login.html");
    }

    // PREVENT CUSTOMER FROM SEEING login/register
    if (customer && (path === "/login.html" || path === "/register.html")) {
        return (window.location.href = "/dashboard.html");
    }

    // PREVENT ADMIN FROM SEEING admin_login
    if (admin && path === "/admin_login.html") {
        return (window.location.href = "/admin.html");
    }
}

// ================================================================
// INIT
// ================================================================
document.addEventListener("DOMContentLoaded", () => {
    injectNavbar();
    enforceAccess();
});