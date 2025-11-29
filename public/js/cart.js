// ===============================
// cart.js — FINAL WORKING VERSION
// Fully synced with backend (/api/cart expects productId)
// ===============================

// Mirror product info (display only)
const PRODUCTS = {
    "love-basic": {
        name: "LoveText Basic Subscription",
        price: 5.00
    },
    "love-premium": {
        name: "LoveText Premium",
        price: 15.00
    },
    "custom-pack": {
        name: "Custom Love Message Pack",
        price: 9.99
    }
};

async function loadCart() {
    try {
        const res = await fetch('/api/cart', { credentials: 'include' });
        const cart = await res.json();

        const container = document.getElementById('cartItems');
        const totalBox = document.getElementById('cartTotal');
        const checkoutBtn = document.getElementById('checkoutBtn');

        // If cart empty
        if (!cart.items || cart.items.length === 0) {
            container.innerHTML = `<div class="empty">Your cart is empty.</div>`;
            totalBox.innerHTML = "";
            checkoutBtn.style.display = "none";
            return;
        }

        let total = 0;
        container.innerHTML = "";

        // Loop through items
        cart.items.forEach(item => {
            const p = PRODUCTS[item.productId];  // ✔ correct key for backend

            if (!p) return;

            const lineTotal = p.price * item.quantity;
            total += lineTotal;

            container.innerHTML += `
                <div class="item">
                    <div class="item-info">
                        <div class="item-name">${p.name}</div>
                        <div class="item-price">$${p.price.toFixed(2)} × ${item.quantity}</div>
                    </div>

                    <button class="remove-btn" onclick="removeItem('${item.productId}')">
                        Remove
                    </button>
                </div>
            `;
        });

        totalBox.innerHTML = `Total: $${total.toFixed(2)}`;
        checkoutBtn.style.display = "inline-block";

    } catch (err) {
        console.error("Error loading cart:", err);
        document.getElementById('cartItems').innerHTML =
            `<div class="empty">Error loading cart.</div>`;
    }
}

// ===============================
// Remove item – SEND productId
// ===============================
async function removeItem(productId) {
    try {
        await fetch('/api/cart/remove', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId })   // ✔ backend requires productId
        });

        loadCart();

    } catch (err) {
        console.error("Remove error:", err);
        alert("Error removing item.");
    }
}

// ===============================
// Checkout
// ===============================
document.getElementById('checkoutBtn').onclick = async () => {
    try {
        const res = await fetch('/api/cart/checkout', {
            method: 'POST',
            credentials: 'include'
        });

        const data = await res.json();

        if (data.url) {
            window.location = data.url;
        } else {
            alert("Checkout error.");
        }

    } catch (err) {
        console.error("Checkout failed:", err);
        alert("Checkout failed.");
    }
};

loadCart();
