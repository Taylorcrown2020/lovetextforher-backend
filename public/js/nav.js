/***************************************************************
 *  FIXED NAVIGATION SYSTEM (nav.js)
 *  
 *  Fixes:
 *  - Proper logout clearing
 *  - No auto-login on public pages
 *  - Correct authentication state management
 ***************************************************************/

(function() {
    'use strict';

    // Check if we should force public nav (for homepage, etc.)
    const forcePublic = window.FORCE_PUBLIC_NAV === true;

    // Get current page
    const currentPage = window.location.pathname;
    
    // Define public pages that don't require authentication
    const publicPages = [
        '/',
        '/index.html',
        '/products.html',
        '/register.html',
        '/login.html',
        '/reset_password.html',
        '/forgot_password.html'
    ];

    const isPublicPage = publicPages.includes(currentPage) || forcePublic;

    /***************************************************************
     *  CHECK AUTHENTICATION STATUS
     ***************************************************************/
    async function checkAuth() {
        try {
            const res = await fetch('/api/customer/me', {
                credentials: 'include',
                cache: 'no-store'
            });

            if (res.ok) {
                const data = await res.json();
                return { 
                    isAuthenticated: true, 
                    customer: data.customer,
                    role: 'customer'
                };
            }
        } catch (e) {
            // Not logged in as customer, try admin
        }

        try {
            const res = await fetch('/api/admin/me', {
                credentials: 'include',
                cache: 'no-store'
            });

            if (res.ok) {
                const data = await res.json();
                return { 
                    isAuthenticated: true, 
                    admin: data.admin,
                    role: 'admin'
                };
            }
        } catch (e) {
            // Not logged in as admin either
        }

        return { isAuthenticated: false, role: null };
    }

    /***************************************************************
     *  RENDER NAVBAR
     ***************************************************************/
    function renderNavbar(authState) {
        const navbar = document.getElementById('navbar');
        if (!navbar) return;

        const { isAuthenticated, role, customer, admin } = authState;

        // PUBLIC NAVBAR (not logged in)
        if (!isAuthenticated || forcePublic) {
            navbar.innerHTML = `
                <nav style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 80px;
                    background: rgba(255,255,255,0.95);
                    backdrop-filter: blur(10px);
                    border-bottom: 1px solid rgba(0,0,0,0.05);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0 40px;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.05);
                ">
                    <div style="
                        font-size: 24px;
                        font-weight: 800;
                        background: linear-gradient(90deg, #d6336c, #8b5cf6);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        cursor: pointer;
                    " onclick="window.location.href='/'">
                        LoveTextForHer
                    </div>

                    <div style="display: flex; gap: 20px; align-items: center;">
                        ${!isAuthenticated ? `
                            <a href="/products.html" style="
                                color: #1a1a1a;
                                text-decoration: none;
                                font-weight: 600;
                                font-size: 16px;
                                transition: color 0.2s;
                            ">Plans</a>
                            
                            <a href="/login.html" style="
                                color: #1a1a1a;
                                text-decoration: none;
                                font-weight: 600;
                                font-size: 16px;
                                transition: color 0.2s;
                            ">Login</a>
                            
                            <a href="/register.html" style="
                                background: #d6336c;
                                color: white;
                                padding: 10px 20px;
                                border-radius: 8px;
                                text-decoration: none;
                                font-weight: 600;
                                font-size: 16px;
                                transition: background 0.2s;
                            ">Get Started</a>
                        ` : `
                            <a href="/dashboard.html" style="
                                background: #d6336c;
                                color: white;
                                padding: 10px 20px;
                                border-radius: 8px;
                                text-decoration: none;
                                font-weight: 600;
                                font-size: 16px;
                                transition: background 0.2s;
                            ">Go to Dashboard</a>
                        `}
                    </div>
                </nav>
            `;
            return;
        }

        // CUSTOMER NAVBAR (logged in as customer)
        if (role === 'customer') {
            navbar.innerHTML = `
                <nav style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 80px;
                    background: rgba(255,255,255,0.95);
                    backdrop-filter: blur(10px);
                    border-bottom: 1px solid rgba(0,0,0,0.05);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0 40px;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.05);
                ">
                    <div style="
                        font-size: 24px;
                        font-weight: 800;
                        background: linear-gradient(90deg, #d6336c, #8b5cf6);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        cursor: pointer;
                    " onclick="window.location.href='/dashboard.html'">
                        LoveTextForHer
                    </div>

                    <div style="display: flex; gap: 20px; align-items: center;">
                        <a href="/dashboard.html" style="
                            color: #1a1a1a;
                            text-decoration: none;
                            font-weight: 600;
                            font-size: 16px;
                        ">Dashboard</a>
                        
                        <a href="/products.html" style="
                            color: #1a1a1a;
                            text-decoration: none;
                            font-weight: 600;
                            font-size: 16px;
                        ">Plans</a>

                        <button id="logoutBtn" style="
                            background: #dc3545;
                            color: white;
                            padding: 10px 20px;
                            border-radius: 8px;
                            border: none;
                            font-weight: 600;
                            font-size: 16px;
                            cursor: pointer;
                            transition: background 0.2s;
                        ">Logout</button>
                    </div>
                </nav>
            `;

            // Add logout handler
            const logoutBtn = document.getElementById('logoutBtn');
            if (logoutBtn) {
                logoutBtn.addEventListener('click', handleLogout);
            }
            return;
        }

        // ADMIN NAVBAR (logged in as admin)
        if (role === 'admin') {
            navbar.innerHTML = `
                <nav style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 80px;
                    background: rgba(139,92,246,0.95);
                    backdrop-filter: blur(10px);
                    border-bottom: 1px solid rgba(0,0,0,0.1);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0 40px;
                    z-index: 1000;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                ">
                    <div style="
                        font-size: 24px;
                        font-weight: 800;
                        color: white;
                        cursor: pointer;
                    " onclick="window.location.href='/admin_dashboard.html'">
                        LoveTextForHer Admin
                    </div>

                    <div style="display: flex; gap: 20px; align-items: center;">
                        <a href="/admin_dashboard.html" style="
                            color: white;
                            text-decoration: none;
                            font-weight: 600;
                            font-size: 16px;
                        ">Dashboard</a>

                        <button id="adminLogoutBtn" style="
                            background: rgba(255,255,255,0.2);
                            color: white;
                            padding: 10px 20px;
                            border-radius: 8px;
                            border: 1px solid rgba(255,255,255,0.3);
                            font-weight: 600;
                            font-size: 16px;
                            cursor: pointer;
                            transition: background 0.2s;
                        ">Logout</button>
                    </div>
                </nav>
            `;

            // Add admin logout handler
            const adminLogoutBtn = document.getElementById('adminLogoutBtn');
            if (adminLogoutBtn) {
                adminLogoutBtn.addEventListener('click', handleAdminLogout);
            }
            return;
        }
    }

    /***************************************************************
     *  HANDLE CUSTOMER LOGOUT
     ***************************************************************/
    async function handleLogout(e) {
        if (e) e.preventDefault();
        
        try {
            const res = await fetch('/api/customer/logout', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (res.ok) {
                // Clear any local state
                sessionStorage.clear();
                localStorage.removeItem('customer_token'); // Just in case
                
                // Force reload to clear any cached state
                window.location.href = '/login.html';
            } else {
                console.error('Logout failed');
                alert('Logout failed. Please try again.');
            }
        } catch (err) {
            console.error('Logout error:', err);
            alert('Logout error. Please try again.');
        }
    }

    /***************************************************************
     *  HANDLE ADMIN LOGOUT
     ***************************************************************/
    async function handleAdminLogout(e) {
        if (e) e.preventDefault();
        
        try {
            const res = await fetch('/api/admin/logout', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (res.ok) {
                // Clear any local state
                sessionStorage.clear();
                localStorage.removeItem('admin_token'); // Just in case
                
                // Force reload to clear any cached state
                window.location.href = '/admin_login.html';
            } else {
                console.error('Admin logout failed');
                alert('Logout failed. Please try again.');
            }
        } catch (err) {
            console.error('Admin logout error:', err);
            alert('Logout error. Please try again.');
        }
    }

    /***************************************************************
     *  PAGE PROTECTION (redirect if not authenticated)
     ***************************************************************/
    function protectPage(authState) {
        const { isAuthenticated, role } = authState;

        // Don't protect public pages
        if (isPublicPage) return;

        // Customer pages
        const customerPages = ['/dashboard.html'];
        const isCustomerPage = customerPages.some(page => currentPage.includes(page));

        if (isCustomerPage && (!isAuthenticated || role !== 'customer')) {
            window.location.href = '/login.html';
            return;
        }

        // Admin pages
        const adminPages = ['/admin_dashboard.html', '/admin_login.html'];
        const isAdminPage = adminPages.some(page => currentPage.includes(page));

        if (isAdminPage && currentPage !== '/admin_login.html') {
            if (!isAuthenticated || role !== 'admin') {
                window.location.href = '/admin_login.html';
                return;
            }
        }
    }

    /***************************************************************
     *  INITIALIZE
     ***************************************************************/
    async function init() {
        const authState = await checkAuth();
        
        console.log('🔐 Auth State:', authState);
        console.log('📄 Current Page:', currentPage);
        console.log('🌐 Is Public Page:', isPublicPage);

        renderNavbar(authState);
        protectPage(authState);
    }

    // Run on DOMContentLoaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();