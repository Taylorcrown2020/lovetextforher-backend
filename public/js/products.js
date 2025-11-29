// ======================================
// products.js — Local Product List
// ======================================

// Same database used by product.js and cart.js
const PRODUCTS = {
    "love-basic": {
        id: "love-basic",
        name: "LoveText Basic Subscription",
        price: 5.00,
        billing: "Monthly",
        description: "Send daily automated love messages to one special person.",
        image: "/img/love-basic.jpg"
    },
    "love-premium": {
        id: "love-premium",
        name: "LoveText Premium",
        price: 15.00,
        billing: "Monthly",
        description: "Up to 5 recipients with advanced scheduling.",
        image: "/img/love-premium.jpg"
    },
    "custom-pack": {
        id: "custom-pack",
        name: "Custom Love Message Pack",
        price: 9.99,
        billing: "One-time",
        description: "20 preset romantic messages delivered at your schedule.",
        image: "/img/custom-pack.jpg"
    }
};

function loadProducts() {
    const grid = document.getElementById("productGrid");
    grid.innerHTML = "";

    Object.values(PRODUCTS).forEach(p => {
        grid.innerHTML += `
            <div class="card">
                <img src="${p.image}" alt="${p.name}">
                <div class="name">${p.name}</div>
                <div class="price">$${p.price.toFixed(2)} — ${p.billing}</div>

                <a class="btn btn-view" href="/products.html?id=${p.id}">
                    View Details
                </a>

                <button class="btn btn-add" onclick="addToCart('${p.id}')">
                    Add to Cart
                </button>
            </div>
        `;
    });
}

// ======================================
// Add to cart (correct format)
// ======================================
async function addToCart(productId) {
    const res = await fetch("/api/cart/add", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }) // THIS IS WHAT BACKEND EXPECTS
    });

    const data = await res.json();

    if (data.success) {
        window.location.href = "/cart.html";
    } else {
        alert(data.error || "Unable to add to cart.");
    }
}

document.addEventListener("DOMContentLoaded", loadProducts);
