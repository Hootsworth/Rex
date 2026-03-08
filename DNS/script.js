const form = document.getElementById('dns-form');
const domainInput = document.getElementById('domain');
const result = document.getElementById('result');

async function lookupDNS(domain) {
    const response = await fetch(`https://dns-api.org/api/v1/lookup/${encodeURIComponent(domain)}`);
    if (!response.ok) {
        throw new Error(`Lookup failed with status ${response.status}`);
    }
    return response.json();
}

function renderRecords(records) {
    if (!Array.isArray(records) || records.length === 0) {
        result.textContent = 'No DNS records found.';
        return;
    }

    result.innerHTML = records
        .map((record) => `<div><strong>${record.type || 'N/A'}</strong>: ${record.value || 'N/A'}</div>`)
        .join('');
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const domain = domainInput.value.trim();

    if (!domain) {
        result.textContent = 'Please enter a domain name.';
        return;
    }

    result.textContent = 'Looking up DNS records...';
    try {
        const records = await lookupDNS(domain);
        renderRecords(records);
    } catch (err) {
        result.textContent = `Error: ${err.message}`;
    }
});