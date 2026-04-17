// State management
const trayState = {
    routineActive: false,
    focusSessionActive: false,
    dayTime: true,
    // subscriptionActive: false
};

function updateFocusSessionUI() {
    const focusBtn = document.getElementById('focus-session');

    // Focus Session Button - change text and color
    if (trayState.focusSessionActive) {
        focusBtn.textContent = 'Stop Focus Session';
        focusBtn.className = 'tray-button active';
    } else {
        focusBtn.textContent = 'Start Focus Session';
        focusBtn.className = 'tray-button primary';
    }
}

const updateRoutineSessionUI = async () => {
    const resumeBtn = document.getElementById('resume-habits');
    const habits = document.querySelectorAll(".layout");

    console.log('Routine active:', trayState.routineActive);
    console.log('dayTime:', trayState.dayTime);

    // Resume Habits Button - hide when completed
    // resumeBtn.style.display = trayState.habitsCompleted ? 'none' : 'block';
    try {
        const data = await window.api.runRoutine();
        console.log('Routine data:', data);

        if (data) {
            console.log('test');
        }
    } catch (err) {
        console.error('Failed to load routine:', err);
    }

    if (!trayState.routineActive) {
        resumeBtn.className = 'tray-button active';
        resumeBtn.textContent = trayState.dayTime ? 'Begin Morning Routine ☀️' : 'Start Evening Routine 🌙';
        habits.forEach(el => {
            el.classList.toggle('accordion-active', trayState.routineActive);
        });
        // const habitList = document.querySelectorAll(".accordion__answer");
        // habitList.forEach(container => {
        //     container.innerHTML = result
        //         .map(habit => `<li>${habit.name}</li>`)
        //         .join('');
        // });
    } else {
        resumeBtn.className = 'tray-button primary';
        resumeBtn.textContent = trayState.dayTime ? 'Pause Morning Routine ☀️' : 'Pause Evening Routine 🌙';
        habits.forEach(el => {
            el.classList.toggle('accordion-active', trayState.routineActive);
        });
        // const habitList = document.querySelectorAll(".accordion__answer");
        // habitList.forEach(container => {
        //     container.innerHTML = result
        //         .map(habit => `<li>${habit.name}</li>`)
        //         .join('');
        // });
    }
}

// function updateSubscriptionUI () {
//     const subBtn = document.getElementById('subscription');

//     console.log("Not yet implemented")
// }

function updateUI() {
    let habits = document.querySelectorAll(".accordion");
    habits.forEach((event) => {
        event.addEventListener("click", () => {
            if (event.classList.contains("active")) {
                event.classList.remove("active");
        } else {
            event.classList.add("active");
        }
    });

    updateFocusSessionUI();
    updateRoutineSessionUI();
});
}

// Button event handlers
function resumeHabits() {
    trayState.routineActive = !trayState.routineActive
    window.api?.toggleRoutineSession?.(trayState.routineActive);
    updateRoutineSessionUI();
}

function openPreferences() {
    window.api?.showPreferences?.();
}

function openTodoList() {
    window.api?.openTodoList?.();
}

function toggleFocusSession() {
    trayState.focusSessionActive = !trayState.focusSessionActive;
    window.api?.toggleFocusSession?.(trayState.focusSessionActive);
    updateFocusSessionUI();
}

function quit() {
    window.api.showQuitDialog();
}

function upgrade() {
    window.api?.showUpgrade?.();
}

// Event listeners
function setupEventListeners() {
    document.getElementById('resume-habits').addEventListener('click', resumeHabits);
    document.getElementById('focus-session').addEventListener('click', toggleFocusSession);
    document.getElementById('subscription').addEventListener('click', upgrade);
}

// Initialize when DOM is loaded
function init() {
    setupEventListeners();
    updateUI();
    
    // Listen for state updates from main process


    if (window.api?.onFocusSessionResult) {
        window.api.onFocusSessionResult((message) => {
            console.log('Focus session result:', message);
        });
    }

    // Add listener for state broadcasts
    if (window.api?.onFocusStateChanged) {
        // You'll need to add this to preload.js
        window.api.onFocusStateChanged?.((isActive) => {
            trayState.focusSessionActive = isActive;
            updateFocusSessionUI();
        });
    }

    // Add listener for state broadcasts
    if (window.api?.onRoutineStateChanged) {
        // You'll need to add this to preload.js
        window.api.onRoutineStateChanged?.((isActive) => {
            trayState.routineActive = isActive;
            updateRoutineSessionUI();
        });
    }
}

// Initialize when page loads
window.addEventListener('DOMContentLoaded', init);