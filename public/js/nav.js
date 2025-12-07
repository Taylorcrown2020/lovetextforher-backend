/* ============================================================
   nav.js — FINAL VERSION
   Fully compatible with your new backend
============================================================ */

document.addEventListener("DOMContentLoaded", () => {
    buildNavbar();
});

/* ============================================================
   BUILD NAVBAR
============================================================ */
async function buildNavbar() {
    const nav = document.getElementById("navbar");
    if (!nav) return;

    const user = await getCustomer();

    nav.innerHTML = `
        <div style="
            width:100%;
            padding:18px 24px;
            display:flex;
            justify-content:space-between;
            align-items:center;
            background:white;
            border-bottom:1px solid #f1c3d6;
            position:fixed;
            top:0;
            left:0;
            z-index:1000;
        ">

            <a href="/index.html" style="text-decoration:none;color:#d6336c;font-size:22px;font-weight:800;">
                LoveTextForHer
            </a>

            <div style="display:flex; gap:20px; align-items:center;">
                ${user ? authLinks() : guestLinks()}
            </div>
        </div>
    `;
}

/* ============================================================
   NAV OPTIONS
============================================================ */
function guestLinks() {
    return `
        <a href="/products.html" style="color:#d6336c;font-weight:600;">Products</a>
        <a href="/login.html" style="color:#d6336c;font-weight:600;">Login</a>
        <a href="/register.html" style="color:#d6336c;font-weight:600;">Sign Up</a>
    `;
}

function authLinks() {
    return `
        <a href="/products.html" style="color:#d6336c;font-weight:600;">Products</a>
        <a href="/dashboard.html" style="color:#d6336c;font-weight:600;">Dashboard</a>
        <button onclick="logout()" 
            style="background:#d6336c;color:white;padding:8px 14px;border:none;border-radius:8px;cursor:pointer;">
            Logout
        </button>
    `;
}

/* ============================================================
   CHECK CUSTOMER SESSION
============================================================ */
async function getCustomer() {
    try {
        const res = await fetch("/api/customer/me", {
            credentials: "include",
            cache: "no-store"
        });

        const data = await res.json();
        return data.customer || null;

    } catch (err) {
        return null;
    }
}

/* ============================================================
   LOGOUT
============================================================ */
async function logout() {
    await fetch("/api/customer/logout", {
        method: "POST",
        credentials: "include"
    });

    window.location.href = "/index.html";
}