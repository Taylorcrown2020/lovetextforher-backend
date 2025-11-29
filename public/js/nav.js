// ======================================================
// nav.js — Universal Navbar Injection + Access Control
// ======================================================

// Pages like login/register must stay public
const FORCE_PUBLIC = window.FORCE_PUBLIC_NAV === true;

// Skip nav injection if page disables it
let SKIP_NAV = window.SKIP_NAV_JS === true;

// ------------------------------------------------------
// Simple API Wrapper
// ------------------------------------------------------
async function api(path, options = {}) {
    try {
        const res = await fetch(path, {
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            ...options
        });
        return await res.json();
    } catch {
        return {};
    }
}

// ------------------------------------------------------
// AUTH HELPERS
// ------------------------------------------------------
async function getCustomer() {
    if (FORCE_PUBLIC) return null;
    const d = await api("/api/customer/me");
    return d && d.id ? d : null;
}

async function checkAdmin() {
    if (FORCE_PUBLIC) return false;

    try {
        const res = await fetch("/api/admin/me", { credentials: "include" });

        if (!res.ok) return false;

        const d = await res.json();
        return d && d.admin && d.admin.role === "admin";
    } catch {
        return false;
    }
}

// ------------------------------------------------------
// CART COUNT
// ------------------------------------------------------
async function getCartCount() {
    const data = await api("/api/cart");
    if (!data.items) return 0;
    return data.items.reduce((n, i) => n + (i.quantity || 1), 0);
}

// ------------------------------------------------------
// ENSURE NAVBAR CONTAINER
// ------------------------------------------------------
function ensureNavbar() {
    let el = document.getElementById("navbar");
    if (!el) {
        el = document.createElement("div");
        el.id = "navbar";
        document.body.prepend(el);
    }
    return el;
}

// ------------------------------------------------------
// Inject Navbar
// ------------------------------------------------------
async function injectNavbar() {
    if (SKIP_NAV) return;

    const container = ensureNavbar();
    const user = await getCustomer();
    const admin = await checkAdmin();

    let cartCount = user ? await getCartCount() : 0;
    const bubble = cartCount > 0 ? `<span class="cart-bubble">${cartCount}</span>` : "";

    const style = `
        <style>
            #navbar {
                width: 100%;
                background: rgba(255,255,255,0.7);
                backdrop-filter: blur(18px);
                box-shadow: 0 2px 14px rgba(0,0,0,0.05);
                padding: 18px 0;
                position: fixed;
                top: 0;
                z-index: 1000;
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
                color: #1a1a1a;
                font-weight: 500;
                position: relative;
            }
            .nav-links a:hover { color: #d6336c; }
            .cart-bubble {
                position: absolute;
                top: -10px;
                right: -12px;
                background: #d6336c;
                color: white;
                padding: 2px 7px;
                font-size: 12px;
                border-radius: 999px;
                font-weight: 700;
            }
        </style>
    `;

    let html = style;

    // ------------------------------------------------------
    // PUBLIC NAV (Login/Register)
    // ------------------------------------------------------
    if (FORCE_PUBLIC) {
        html += `
        <div class="nav-inner">
            <div class="nav-logo">LOVETEXTFORHER</div>
            <div class="nav-links">
                <a href="/index.html">Home</a>
                <a href="/login.html">Login</a>
                <a href="/register.html">Register</a>
                <a href="/admin_login.html">Admin</a>
            </div>
        </div>`;
        container.innerHTML = html;
        return;
    }

    // ------------------------------------------------------
    // ADMIN NAV — ONLY IF ADMIN AND PAGE STARTS WITH /admin
    // ------------------------------------------------------
    if (admin && window.location.pathname.startsWith("/admin")) {
        html += `
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
        container.innerHTML = html;
        document.getElementById("logout-admin").onclick = logoutAdmin;
        return;
    }

    // ------------------------------------------------------
    // CUSTOMER NAV
    // ------------------------------------------------------
    if (user) {
        html += `
        <div class="nav-inner">
            <div class="nav-logo">LOVETEXTFORHER</div>
            <div class="nav-links">
                <a href="/dashboard.html">Dashboard</a>
                <a href="/products.html">Products</a>
                <a href="/cart.html">Cart ${bubble}</a>
                <a href="#" id="logout-customer">Logout</a>
            </div>
        </div>`;
        container.innerHTML = html;
        document.getElementById("logout-customer").onclick = logoutCustomer;
        return;
    }

    // ------------------------------------------------------
    // VISITOR NAV
    // ------------------------------------------------------
    html += `
    <div class="nav-inner">
        <div class="nav-logo">LOVETEXTFORHER</div>
        <div class="nav-links">
            <a href="/index.html">Home</a>
            <a href="/login.html">Login</a>
            <a href="/register.html">Register</a>
            <a href="/admin_login.html">Admin</a>
        </div>
    </div>`;

    container.innerHTML = html;
}

// ------------------------------------------------------
// LOGOUT HANDLERS
// ------------------------------------------------------
async function logoutCustomer() {
    await api("/api/customer/logout", { method: "POST" });
    window.location.href = "/login.html";
}

async function logoutAdmin() {
    await api("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin_login.html";
}

// ------------------------------------------------------
// ACCESS CONTROL RULES
// ------------------------------------------------------
async function enforcePageRules() {
    const path = window.location.pathname;

    if (FORCE_PUBLIC) return;

    const user = await getCustomer();
    const admin = await checkAdmin();

    // ADMIN PROTECTED PAGES
    if (path.startsWith("/admin") && path !== "/admin_login.html") {
        if (!admin) window.location = "/admin_login.html";
        return;
    }

    // CUSTOMER PROTECTED PAGES
    const protectedPages = ["/dashboard.html", "/products.html", "/cart.html"];
    if (protectedPages.includes(path)) {
        if (!user) window.location = "/login.html";
        return;
    }

    // Prevent logged-in customers from going to login/register
    if (user && (path === "/login.html" || path === "/register.html")) {
        window.location = "/dashboard.html";
    }
}

// ------------------------------------------------------
// INIT
// ------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    injectNavbar();
    enforcePageRules();
});