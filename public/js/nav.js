/********************************************************************
 *  NAV.JS — FINAL FULLY-COMPATIBLE VERSION
 *  Safe, stable, matches the new server.js exactly.
 ********************************************************************/

// ================================================================
// EARLY EXIT: Some pages explicitly disable nav.js
// ================================================================
if (window.SKIP_NAV_JS === true) {
    console.log("⛔ nav.js disabled for this page");
    throw new Error("NAV_JS_DISABLED");
}

// ================================================================
// API WRAPPER (always disable caching for auth endpoints)
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

// ================================================================
// AUTH HELPERS
// ================================================================
async function getCustomer() {
    if (window.FORCE_PUBLIC_NAV) return null;
    try {
        const d = await api("/api/customer/me");
        return d?.id ? d : null;
    } catch {
        return null;
    }
}

async function getAdmin() {
    if (window.FORCE_PUBLIC_NAV) return false;
    try {
        const res = await fetch("/api/admin/me", {
            credentials: "include",
            cache: "no-store"
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data?.admin?.role === "admin";
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
// ENSURE #navbar EXISTS
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
// NAVBAR HTML
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
// LOGOUT FUNCTIONS
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
// BUILD NAV — MASTER FUNCTION
// ================================================================
async function injectNavbar() {
    const navbar = ensureNavbarEl();

    // --- ALWAYS inject the CSS first ---
    navbar.innerHTML = `
        <style>
            #navbar {
                position: fixed;
                top: 0;
                left: 0;
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
        </style>
    `;

    const path = window.location.pathname;
    const admin = await getAdmin();
    const customer = await getCustomer();

    // ADMIN PAGES (except login)
    if (admin && path.startsWith("/admin") && path !== "/admin_login.html") {
        navbar.innerHTML += adminNav();
        document.getElementById("logout-admin").onclick = logoutAdmin;
        return;
    }

    // PUBLIC MODE FORCED
    if (window.FORCE_PUBLIC_NAV === true) {
        navbar.innerHTML += publicNav();
        return;
    }

    // CUSTOMER NAV
    if (customer) {
        const count = await getCartCount();
        const bubble = count > 0 ? `<span class="cart-bubble">${count}</span>` : "";
        navbar.innerHTML += customerNav(bubble);
        document.getElementById("logout-customer").onclick = logoutCustomer;
        return;
    }

    // DEFAULT → PUBLIC NAV
    navbar.innerHTML += publicNav();
}

// ================================================================
// PAGE ACCESS RULES
// ================================================================
async function enforcePageRules() {
    if (window.FORCE_PUBLIC_NAV === true) return;

    const customer = await getCustomer();
    const admin = await getAdmin();
    const path = window.location.pathname;

    // ---------------- ADMIN ACCESS CONTROL ----------------
    if (path.startsWith("/admin") && path !== "/admin_login.html") {
        if (!admin) window.location.href = "/admin_login.html";
        return;
    }

    // ---------------- CUSTOMER PAGES ----------------
    const protectedPages = [
        "/dashboard.html",
        "/products.html",
        "/cart.html"
    ];

    if (protectedPages.includes(path) && !customer) {
        window.location.href = "/login.html";
        return;
    }

    // ---------------- DISALLOW LOGIN/REGISTER IF LOGGED IN ----------------
    if (customer && (path === "/login.html" || path === "/register.html")) {
        window.location.href = "/dashboard.html";
        return;
    }
}

// ================================================================
// INIT
// ================================================================
document.addEventListener("DOMContentLoaded", () => {
    injectNavbar();
    enforcePageRules();
});