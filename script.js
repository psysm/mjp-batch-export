(async function runAscendingBatchJob() {

    // ============================================================
    // 0. GLOBAL STATE & INTERCEPTOR (The "Hack")
    // ============================================================
    
    let currentBatchUuid = null;
    const originalCreateElement = document.createElement;

    document.createElement = function(tagName) {
        const element = originalCreateElement.call(document, tagName);
        
        if (tagName.toLowerCase() === 'a') {
            Object.defineProperty(element, 'download', {
                set: function(originalName) {
                    if (currentBatchUuid && originalName && originalName.toLowerCase().endsWith('.zip') && !originalName.includes(currentBatchUuid)) {
                        
                        let baseName = originalName.substring(0, originalName.length - 4);
                        
                        // Remove trailing underscore if present
                        if (baseName.endsWith('_')) {
                            baseName = baseName.slice(0, -1);
                        }
                        
                        const newName = `${baseName}_${currentBatchUuid}.zip`;
                        
                        console.log(`   ✂ Renaming ZIP: ${originalName} -> ${newName}`);
                        this.setAttribute('download', newName);
                    } else {
                        this.setAttribute('download', originalName);
                    }
                },
                get: function() { return this.getAttribute('download'); }
            });
        }
        return element;
    };

    // ============================================================
    // 1. CONFIGURATION & DYNAMIC DATA FETCHING
    // ============================================================
    
    const INCOMING_BASE = "https://api.mjp.justiz.de/api/v1/public/messages/ebo/incoming";
    const OUTGOING_BASE = "https://api.mjp.justiz.de/api/v1/public/messages/ebo/outgoing";

    async function fetchFullList(baseUrl, typeLabel) {
        console.log(`%c[${typeLabel}] Checking total count...`, "color: blue");
        try {
            // 1. Ping for total (Updated to ascending=true)
            const pingUrl = `${baseUrl}?page=0&itemsPerPage=10&ascending=true&sortBy=ozgppCreationTime`;
            const pingResp = await fetch(pingUrl, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } });
            if (!pingResp.ok) throw new Error(`HTTP ${pingResp.status}`);
            const pingJson = await pingResp.json();
            const total = pingJson.total || 0;

            if (total === 0) return [];

            // 2. Fetch all
            const dynamicLimit = Math.ceil(total / 10) * 10;
            console.log(`%c[${typeLabel}] Total: ${total}. Fetching ${dynamicLimit} items...`, "color: blue");
            
            // Full fetch (Updated to ascending=true)
            const fullUrl = `${baseUrl}?page=0&itemsPerPage=${dynamicLimit}&ascending=true&sortBy=ozgppCreationTime`;
            const fullResp = await fetch(fullUrl, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } });
            const fullJson = await fullResp.json();
            
            console.log(`%c[${typeLabel}] ✔ Loaded ${fullJson.eboMessages.length} messages.`, "color: green");
            return fullJson.eboMessages || [];
        } catch (e) {
            console.error(`[${typeLabel}] Error:`, e);
            return [];
        }
    }

    // --- BUILD QUEUE ---
    const incomingMessages = await fetchFullList(INCOMING_BASE, "INCOMING");
    const outgoingMessages = await fetchFullList(OUTGOING_BASE, "OUTGOING");

    const queue = [];
    
    // Process Outgoing first
    outgoingMessages.forEach(msg => queue.push({ uuid: msg.messageUuid, url: `#/postausgang/detail/${msg.messageUuid}`, listView: '#/postausgang', type: 'OUTGOING' }));
    
    // Process Incoming second
    incomingMessages.forEach(msg => queue.push({ uuid: msg.messageUuid, url: `#/posteingang/detail/${msg.messageUuid}`, listView: '#/posteingang', type: 'INCOMING' }));

    if (queue.length === 0) { console.warn("Queue empty. Stopping."); return; }
    console.log(`%cReady to process ${queue.length} items.`, "font-size: 14px; font-weight: bold; color: green;");

    // ============================================================
    // 2. HELPER FUNCTIONS
    // ============================================================

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function waitForMessageLoad(uuid, timeout = 15000) {
        const selector = `[data-uuid="${uuid}"] .btn.save-all-action:not([disabled])`;
        return new Promise((resolve) => {
            if (document.querySelector(selector)) return resolve(document.querySelector(selector));
            
            const obs = new MutationObserver(() => {
                if (document.querySelector(selector)) {
                    obs.disconnect();
                    resolve(document.querySelector(selector));
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
        });
    }

    async function waitForZipSuccess(timeout = 60000) {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const alertAttr = document.querySelector('ozg-alert[data-message*="Ihre Dateien sind erfolgreich heruntergeladen worden"]');
                const alertSpan = Array.from(document.querySelectorAll('.alert-message span'))
                                       .find(el => el.innerText.includes("Ihre Dateien sind erfolgreich heruntergeladen worden"));
                if (alertAttr || alertSpan) {
                    clearInterval(checkInterval);
                    resolve(true);
                }
            }, 500); 
            setTimeout(() => { clearInterval(checkInterval); resolve(false); }, timeout);
        });
    }

    function simulateClick(el) {
        if (!el) return;
        ['mousedown', 'mouseup', 'click'].forEach(evt => 
            el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
        );
    }

    function downloadBlob(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = originalCreateElement.call(document, 'a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // ============================================================
    // 3. PAGE PROCESSOR
    // ============================================================

    async function processPage(item) {
        currentBatchUuid = item.uuid;

        const saveAllBtn = await waitForMessageLoad(item.uuid);
        if (!saveAllBtn) {
            console.error(`   ❌ Timeout loading ${item.uuid}. Skipping.`);
            return;
        }

        let baseName = `Nachweis_${new Date().toISOString().slice(0,10)}`;
        try {
            const comp = document.querySelector(`[data-uuid="${item.uuid}"]`);
            if (comp && comp.messageData && typeof comp.getTransmitter === 'function') {
                const datePart = comp.messageData.ozgppCreationTime.split("T")[0];
                const transmitterPart = comp.getTransmitter();
                baseName = "MJP_" + datePart + transmitterPart;
                if (baseName.endsWith('_')) baseName = baseName.slice(0, -1);
            }
        } catch (e) {}

        const htmlFileName = `${baseName}_${item.uuid}.html`;

        console.log(`   ⬇ Triggering ZIP... (Interceptor will add UUID)`);
        simulateClick(saveAllBtn);
        
        const zipSuccess = await waitForZipSuccess();
        if (!zipSuccess) console.warn(`   ⚠ ZIP timeout (60s). Proceeding anyway.`);
        
        await sleep(800);

        let popupBtn = document.querySelector(`[data-uuid="${item.uuid}"] ozg-popupwindow[data-pagetitle="Prüfvermerk"]`);
        if (!popupBtn) popupBtn = document.querySelector(`[data-uuid="${item.uuid}"] ozg-popupwindow[data-pagetitle="Eingangsbestätigung"]`);

        if (popupBtn) {
            console.log("   ⬇ Generating HTML Proof...");
            await new Promise((resolve) => {
                const originalOpen = window.open;
                let handled = false;

                window.open = function(url, target, features) {
                    const newWin = originalOpen.call(window, url, target, features);
                    if (newWin) {
                        const timer = setInterval(() => {
                            if (newWin.closed) { clearInterval(timer); if(!handled) resolve(); return; }
                            try {
                                if (newWin.document.querySelector('h1') && newWin.document.body.innerHTML.length > 100) {
                                    clearInterval(timer);
                                    downloadBlob(newWin.document.documentElement.outerHTML, htmlFileName, 'text/html');
                                    newWin.close();
                                    handled = true;
                                    window.open = originalOpen;
                                    resolve();
                                }
                            } catch(e){}
                        }, 500);
                    }
                    return newWin;
                };
                simulateClick(popupBtn);
            });
        } else {
            if (item.type === 'OUTGOING') {
                console.warn("   ⚠ No proof button. Generating 'Versand fehlgeschlagen' note.");
                downloadBlob(`<html><body><h1>Versand fehlgeschlagen</h1><p>Message UUID: ${item.uuid}</p></body></html>`, htmlFileName, 'text/html');
            } else {
                console.log("   (Skipping HTML for incoming message with no proof button)");
            }
        }
        
        currentBatchUuid = null;
    }

    // ============================================================
    // 4. MAIN LOOP
    // ============================================================
    
    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        console.log(`\n%c[${i + 1}/${queue.length}] Processing ${item.uuid}`, "color: white; background: #007acc; padding: 2px");

        if (window.location.hash !== item.listView) {
            window.location.hash = item.listView;
            await sleep(600); 
        }

        window.location.hash = item.url;
        await processPage(item);
        
        await sleep(1500);
    }

    console.log("%cBatch Job Complete!", "color: white; background: green; font-size: 20px; padding: 10px;");
    
    document.createElement = originalCreateElement;

})();