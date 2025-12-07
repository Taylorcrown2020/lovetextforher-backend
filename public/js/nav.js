/* ============================================================
   Global Navigation Bar — LoveTextForHer
   Clean, modern, gradient, admin-style aesthetic
   Fully compatible with new backend
============================================================ */

document.addEventListener("DOMContentLoaded", async () => {

    const navbar = document.getElementById("navbar");
    if (!navbar) return;

    navbar.innerHTML = `
        <style>
            /* NAV WRAPPER */
            #ltfh-navbar {
                width: 100%;
                height: 82px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0 40px;
                background: rgba(255,255,255,0.55);
                backdrop-filter: blur(18px);
                border-bottom: 1px solid rgba(255,255,255,0.7);
                position: fixed;
                top: 0;
                left: 0;
                z-index: 9999;
            }

            /* BRAND */
            #ltfh-brand {
                font-size: 22px;
                font-weight: 800;
                background: linear-gradient(90deg, #d6336c, #8b5cf6);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                letter-spacing: .5px;
            }

            /* NAV LINKS */
            #ltfh-links a, 
            #ltfh-links button {
                margin-left: 26px;
                font-size: 16px;
                font-weight: 600;
                text-decoration: none;
                color: #d6336c;
                background: none;
                border: none;
                cursor: pointer;
                padding: 6px 2px;
                transition: .25s;
            }

            #ltfh-links a:hover {
                color: #8b5cf6;
            }

            /* CART — Gradient Button */
            .ltfh-cart-btn {
                padding: 8px 16px;
                background: linear-gradient(90deg,#8b5cf6,#d6336c);
                color: white !important;
                border-radius: 10px;
            }
            .ltfh-cart-btn:hover {
                opacity: .85;
            }

            /* LOGOUT BUTTON */
            .ltfh-logout {
                padding: 8px 16px;
                background: linear-gradient(90deg,#d6336c,#8b5cf6);
                color: white !important;
                border-radius: 10px;
            }
            .ltfh-logout:hover {
                opacity: .85;
            }
        </style>

        <div id="ltfh-navbar">
            <div id="ltfh-brand">LoveTextForHer</div>
            <div id="ltfh-links">Loading...</div>
        </div>
    `;

    const links = document.getElementById("ltfh-links");

    /* ---------------------------------------------------------
       Detect logged-in role
    --------------------------------------------------------- */

    let customer = null;
    let admin = null;

    try {
        const r = await fetch("/api/customer/me", {
            credentials: "include",
            cache: "no-store"
        });
        const data = await r.json();
        if (data.customer) customer = data.customer;
    } catch {}

    try {
        const r = await fetch("/api/admin/me", {
            credentials: "include",
            cache: "no-store"
        });
        const data = await r.json();
        if (data.admin) admin = data.admin;
    } catch {}

    /* ---------------------------------------------------------
       IF ADMIN LOGGED IN
    --------------------------------------------------------- */
    if (admin) {
        links.innerHTML = `
            <a href="/admin.html">Dashboard</a>
            <a href="/admin-users.html">Users</a>
            <a href="/admin-customers.html">Customers</a>
            <a href="/kpi.html">KPIs</a>
            <button class="ltfh-logout" id="logoutAdmin">Logout</button>
        `;

        document.getElementById("logoutAdmin").onclick = async () => {
            await fetch("/api/admin/logout", {
                method: "POST",
                credentials: "include"
            });
            window.location.href = "/login.html";
        };

        return;
    }

    /* ---------------------------------------------------------
       IF CUSTOMER LOGGED IN
    --------------------------------------------------------- */
    if (customer) {
        links.innerHTML = `
            <a href="/products.html">Products</a>
            <a href="/dashboard.html">Dashboard</a>
            <a href="/cart.html" class="ltfh-cart-btn">Cart</a>
            <button class="ltfh-logout" id="logoutCustomer">Logout</button>
        `;

        document.getElementById("logoutCustomer").onclick = async () => {
            await fetch("/api/customer/logout", {
                method: "POST",
                credentials: "include"
            });
            window.location.href = "/index.html";
        };

        return;
    }

    /* ---------------------------------------------------------
       IF LOGGED OUT — Public nav
    --------------------------------------------------------- */
    links.innerHTML = `
        <a href="/products.html">Products</a>
        <a href="/login.html">Login</a>
        <a href="/register.html">Register</a>
    `;
});