/* ============================================================
   Global Navigation Bar — LoveTextForHer (FIXED)
   ✅ Proper async loading
   ✅ Better error handling
   ✅ Mobile responsive
   ✅ Modern gradient design
============================================================ */

(async function initNavbar() {
    const navbar = document.getElementById("navbar");
    if (!navbar) return;

    // Inject navbar HTML + styles
    navbar.innerHTML = `
        <style>
            /* NAV WRAPPER */
            #ltfh-navbar {
                width: 100%;
                height: 80px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0 40px;
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border-bottom: 2px solid rgba(214, 51, 108, 0.1);
                position: fixed;
                top: 0;
                left: 0;
                z-index: 9999;
                box-shadow: 0 2px 15px rgba(0, 0, 0, 0.05);
            }

            /* BRAND */
            #ltfh-brand {
                font-size: 24px;
                font-weight: 800;
                background: linear-gradient(90deg, #d6336c, #8b5cf6);
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                letter-spacing: 0.5px;
                cursor: pointer;
                transition: opacity 0.3s ease;
            }

            #ltfh-brand:hover {
                opacity: 0.8;
            }

            /* NAV LINKS CONTAINER */
            #ltfh-links {
                display: flex;
                align-items: center;
                gap: 20px;
            }

            /* LINKS */
            #ltfh-links a {
                font-size: 16px;
                font-weight: 600;
                text-decoration: none;
                color: #d6336c;
                padding: 8px 12px;
                border-radius: 8px;
                transition: all 0.3s ease;
                position: relative;
            }

            #ltfh-links a:hover {
                color: #8b5cf6;
                background: rgba(139, 92, 246, 0.1);
            }

            /* BUTTONS */
            #ltfh-links button {
                font-size: 16px;
                font-weight: 600;
                padding: 10px 20px;
                border: none;
                border-radius: 10px;
                cursor: pointer;
                transition: all 0.3s ease;
                font-family: inherit;
            }

            /* CART BUTTON */
            .ltfh-cart-btn {
                background: linear-gradient(90deg, #8b5cf6, #d946ef) !important;
                color: white !important;
                padding: 10px 18px !important;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .ltfh-cart-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
            }

            /* LOGOUT BUTTON */
            .ltfh-logout {
                background: linear-gradient(90deg, #d6336c, #8b5cf6) !important;
                color: white !important;
            }

            .ltfh-logout:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(214, 51, 108, 0.4);
            }

            /* LOGIN/REGISTER BUTTONS */
            .ltfh-login {
                background: transparent !important;
                color: #d6336c !important;
                border: 2px solid #d6336c !important;
            }

            .ltfh-login:hover {
                background: #d6336c !important;
                color: white !important;
            }

            .ltfh-register {
                background: linear-gradient(90deg, #d6336c, #8b5cf6) !important;
                color: white !important;
            }

            .ltfh-register:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(214, 51, 108, 0.4);
            }

            /* MOBILE MENU TOGGLE */
            #ltfh-mobile-toggle {
                display: none;
                background: none;
                border: none;
                color: #d6336c;
                font-size: 28px;
                cursor: pointer;
                padding: 8px;
            }

            /* MOBILE STYLES */
            @media (max-width: 768px) {
                #ltfh-navbar {
                    padding: 0 20px;
                    height: 70px;
                }

                #ltfh-brand {
                    font-size: 20px;
                }

                #ltfh-mobile-toggle {
                    display: block;
                }

                #ltfh-links {
                    position: fixed;
                    top: 70px;
                    left: 0;
                    right: 0;
                    background: rgba(255, 255, 255, 0.98);
                    backdrop-filter: blur(20px);
                    flex-direction: column;
                    padding: 20px;
                    gap: 15px;
                    border-bottom: 2px solid rgba(214, 51, 108, 0.1);
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
                    transform: translateY(-100%);
                    opacity: 0;
                    transition: all 0.3s ease;
                    pointer-events: none;
                }

                #ltfh-links.active {
                    transform: translateY(0);
                    opacity: 1;
                    pointer-events: all;
                }

                #ltfh-links a,
                #ltfh-links button {
                    width: 100%;
                    text-align: center;
                    padding: 12px 20px;
                }
            }

            /* LOADING STATE */
            .ltfh-loading {
                color: #999;
                font-size: 14px;
                animation: pulse 1.5s ease-in-out infinite;
            }

            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        </style>

        <div id="ltfh-navbar">
            <div id="ltfh-brand" onclick="window.location.href='/index.html'">
                LoveTextForHer
            </div>
            
            <button id="ltfh-mobile-toggle" aria-label="Toggle menu">
                ☰
            </button>
            
            <div id="ltfh-links">
                <span class="ltfh-loading">Loading...</span>
            </div>
        </div>
    `;

    const linksContainer = document.getElementById("ltfh-links");
    const mobileToggle = document.getElementById("ltfh-mobile-toggle");

    // Mobile menu toggle
    if (mobileToggle) {
        mobileToggle.addEventListener("click", () => {
            linksContainer.classList.toggle("active");
            mobileToggle.textContent = linksContainer.classList.contains("active") ? "✕" : "☰";
        });

        // Close mobile menu when clicking a link
        linksContainer.addEventListener("click", (e) => {
            if (e.target.tagName === "A" || e.target.tagName === "BUTTON") {
                linksContainer.classList.remove("active");
                mobileToggle.textContent = "☰";
            }
        });
    }

    /* ---------------------------------------------------------
       CHECK AUTHENTICATION STATUS
    --------------------------------------------------------- */
    let customer = null;
    let admin = null;

    // Check if customer is logged in
    try {
        const customerRes = await fetch("/api/customer/me", {
            method: "GET",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            cache: "no-store"
        });

        if (customerRes.ok) {
            const data = await customerRes.json();
            if (data.customer) {
                customer = data.customer;
            }
        }
    } catch (err) {
        console.log("Customer check:", err.message);
    }

    // Check if admin is logged in
    try {
        const adminRes = await fetch("/api/admin/me", {
            method: "GET",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            cache: "no-store"
        });

        if (adminRes.ok) {
            const data = await adminRes.json();
            if (data.admin) {
                admin = data.admin;
            }
        }
    } catch (err) {
        console.log("Admin check:", err.message);
    }

    /* ---------------------------------------------------------
       RENDER NAVIGATION BASED ON USER TYPE
    --------------------------------------------------------- */

    // ADMIN NAVIGATION
    if (admin) {
        linksContainer.innerHTML = `
            <a href="/admin.html">📊 Dashboard</a>
            <a href="/admin-users.html">👥 Recipients</a>
            <a href="/admin-customers.html">💳 Customers</a>
            <a href="/kpi.html">📈 Analytics</a>
            <button class="ltfh-logout" id="logoutBtn">Logout</button>
        `;

        document.getElementById("logoutBtn").addEventListener("click", async () => {
            try {
                await fetch("/api/admin/logout", {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" }
                });
                window.location.href = "/login.html";
            } catch (err) {
                console.error("Logout error:", err);
                window.location.href = "/login.html";
            }
        });

        return;
    }

    // CUSTOMER NAVIGATION
    if (customer) {
        linksContainer.innerHTML = `
            <a href="/products.html">🎁 Products</a>
            <a href="/dashboard.html">📋 Dashboard</a>
            <a href="/cart.html" class="ltfh-cart-btn">🛒 Cart</a>
            <button class="ltfh-logout" id="logoutBtn">Logout</button>
        `;

        document.getElementById("logoutBtn").addEventListener("click", async () => {
            try {
                await fetch("/api/customer/logout", {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" }
                });
                window.location.href = "/index.html";
            } catch (err) {
                console.error("Logout error:", err);
                window.location.href = "/index.html";
            }
        });

        return;
    }

    // PUBLIC NAVIGATION (NOT LOGGED IN)
    linksContainer.innerHTML = `
        <a href="/products.html">🎁 Products</a>
        <a href="/login.html">
            <button class="ltfh-login">Login</button>
        </a>
        <a href="/register.html">
            <button class="ltfh-register">Get Started</button>
        </a>
    `;
})();