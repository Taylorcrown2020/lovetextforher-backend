/************************************************************
 * CLEAN, SAFE, RESPONSIVE NAVIGATION BAR
 * - No click hijacking
 * - Customer / Admin detection
 * - Looks clean and modern
 ************************************************************/

async function loadNavbar() {
    const nav = document.getElementById("navbar");
    if (!nav) return;

    // Base styles
    nav.style.padding = "18px 32px";
    nav.style.display = "flex";
    nav.style.justifyContent = "space-between";
    nav.style.alignItems = "center";
    nav.style.borderBottom = "1px solid #f3c9dd";
    nav.style.background = "white";
    nav.style.position = "sticky";
    nav.style.top = "0";
    nav.style.zIndex = "999";

    const brandHTML = `
        <a href="/index.html" style="font-size:24px;font-weight:800;color:#d6336c;text-decoration:none;">
            LoveTextForHer
        </a>
    `;

    // Default navigation (logged out)
    let rightHTML = `
        <a href="/index.html" class="nav-link">Home</a>
        <a href="/products.html" class="nav-link">Products</a>
        <a href="/login.html" class="nav-link">Login</a>
        <a href="/register.html" class="nav-link">Register</a>
        <a href="/admin.html" class="nav-link">Admin Login</a>
    `;

    try {
        /******************************
         * CHECK CUSTOMER LOGIN
         ******************************/
        const cRes = await fetch("/api/customer/me", {
            credentials: "include",
            cache: "no-store"
        });

        if (cRes.ok) {
            const user = await cRes.json();
            if (user?.email) {
                rightHTML = `
                    <a href="/dashboard.html" class="nav-link">Dashboard</a>
                    <a href="/products.html" class="nav-link">Products</a>
                    <a href="/cart.html" class="nav-link">Cart</a>
                    <button id="logoutBtn" class="logout-btn">Logout</button>
                `;
                renderNav(brandHTML, rightHTML);

                bindLogout("/api/customer/logout", "/login.html");
                return;
            }
        }

        /******************************
         * CHECK ADMIN LOGIN
         ******************************/
        const aRes = await fetch("/api/admin/me", {
            credentials: "include",
            cache: "no-store"
        });

        if (aRes.ok) {
            const admin = await aRes.json();

            if (admin?.admin?.email) {
                rightHTML = `
                    <a href="/admin.html" class="nav-link">Admin Dashboard</a>
                    <a href="/admin-recipients.html" class="nav-link">Recipients</a>
                    <button id="logoutBtn" class="logout-btn">Logout</button>
                `;

                renderNav(brandHTML, rightHTML);

                bindLogout("/api/admin/logout", "/admin.html");
                return;
            }
        }

        // Default nav (not logged in)
        renderNav(brandHTML, rightHTML);

    } catch (err) {
        console.error("NAV ERROR:", err);
        renderNav(brandHTML, rightHTML);
    }
}

/************************************************************
 * Render navbar with consistent styling
 ************************************************************/
function renderNav(brandHTML, rightHTML) {
    const nav = document.getElementById("navbar");

    nav.innerHTML = `
        <div style="font-weight:800;">${brandHTML}</div>
        <div class="nav-right" style="
            display:flex;
            gap:28px;
            align-items:center;
            font-size:16px;">
            ${rightHTML}
        </div>
    `;

    styleNavLinks();
}

/************************************************************
 * Logout handling
 ************************************************************/
function bindLogout(endpoint, redirectURL) {
    const btn = document.getElementById("logoutBtn");
    if (!btn) return;

    btn.addEventListener("click", async () => {
        await fetch(endpoint, {
            method: "POST",
            credentials: "include"
        });
        window.location.href = redirectURL;
    });
}

/************************************************************
 * Style all nav links
 ************************************************************/
function styleNavLinks() {
    document.querySelectorAll(".nav-link").forEach(a => {
        a.style.textDecoration = "none";
        a.style.color = "#d6336c";
        a.style.fontWeight = "600";
    });

    const btn = document.querySelector(".logout-btn");
    if (btn) {
        btn.style.background = "#d6336c";
        btn.style.color = "white";
        btn.style.border = "none";
        btn.style.padding = "8px 16px";
        btn.style.borderRadius = "8px";
        btn.style.cursor = "pointer";
        btn.style.fontWeight = "600";
    }
}

document.addEventListener("DOMContentLoaded", loadNavbar);