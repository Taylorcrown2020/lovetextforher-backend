// ============================================
// dashboard.js — Customer Dashboard (Final)
// ============================================

let HAS_SUBSCRIPTION = false;

// -----------------------------------------------------
// Load subscription status
// -----------------------------------------------------
async function loadSubscriptionStatus() {
    try {
        const res = await fetch("/api/customer/subscription", {
            credentials: "include"
        });

        const data = await res.json();
        HAS_SUBSCRIPTION = data.subscribed;

        // If no subscription, show a banner
        if (!HAS_SUBSCRIPTION) {
            document.getElementById("subscriptionBanner").style.display = "block";
        }

    } catch (err) {
        console.error("Subscription check failed:", err);
    }
}


// -----------------------------------------------------
// Load all recipients
// -----------------------------------------------------
async function loadRecipients() {
    try {
        const res = await fetch("/api/customer/recipients", { credentials: "include" });
        const data = await res.json();

        const box = document.getElementById("recipients");
        box.innerHTML = "";

        if (!data || data.length === 0) {
            box.innerHTML = `
                <p style="text-align:center;color:#6a003a;font-size:17px;margin-top:20px;">
                    You have no recipients yet ❤️
                </p>`;
            return;
        }

        data.forEach((r, i) => {
            const timings = Array.isArray(r.timings) ? r.timings.join(", ") : "—";

            box.innerHTML += `
                <div class="recipient-box" style="animation-delay: ${i * 0.07}s;">
                    <strong>${r.name}</strong> (${r.email})<br>
                    <p>Frequency: ${r.frequency}</p>
                    <p>Timing: ${timings}</p>

                    <button onclick="removeRecipient(${r.id})">Delete</button>
                </div>
            `;
        });

    } catch (err) {
        console.error("Error loading recipients:", err);
        document.getElementById("recipients").innerHTML =
            `<p style="color:#b1184a;">Error loading recipients.</p>`;
    }
}


// -----------------------------------------------------
// Add a new recipient — WITH SUBSCRIPTION CHECK
// -----------------------------------------------------
async function addRecipient() {

    // 🔥 BLOCK if not subscribed
    if (!HAS_SUBSCRIPTION) {
        msg.innerText = "You need a subscription to add a recipient.";
        setTimeout(() => {
            window.location.href = "/products.html";
        }, 1200);
        return;
    }

    const name = r_name.value.trim();
    const email = r_email.value.trim();
    const frequency = r_frequency.value;
    const timing = r_timings.value;
    const timezone = r_timezone.value.trim();

    if (!name || !email || !timezone) {
        msg.innerText = "Please fill out all fields.";
        return;
    }

    const payload = {
        name,
        email,
        frequency,
        timings: [timing],
        timezone
    };

    try {
        const res = await fetch("/api/customer/recipients", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.success) {
            msg.innerText = "";
            r_name.value = "";
            r_email.value = "";
            r_timezone.value = "";
            loadRecipients();
        } else {
            msg.innerText = data.error || "Error adding recipient.";
        }

    } catch (err) {
        console.error("Error adding recipient:", err);
        msg.innerText = "Server error. Try again.";
    }
}


// -----------------------------------------------------
// Remove a recipient
// -----------------------------------------------------
async function removeRecipient(id) {
    if (!confirm("Are you sure you want to remove this recipient?")) return;

    try {
        await fetch(`/api/customer/recipients/${id}`, {
            method: "DELETE",
            credentials: "include"
        });

        loadRecipients();

    } catch (err) {
        console.error("Error deleting recipient:", err);
        alert("Error deleting recipient.");
    }
}


// -----------------------------------------------------
// Auto-load everything on page ready
// -----------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    loadSubscriptionStatus();
    loadRecipients();
});