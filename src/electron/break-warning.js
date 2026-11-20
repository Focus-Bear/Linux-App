// Script of the break reminder window (src/ui/break-warning.html). Counts down
// to the break and sends the choice (start / skip / postpone) to the main
// process, which owns the break timer.
import {
    DEFAULT_POSTPONE_MINUTES,
    POSTPONE_OPTIONS,
    WARNING_SECONDS,
    normalisePostpone,
    postponeLabel,
    warningTitle,
} from './breakModel.js';
import { normaliseTheme } from './trayModel.js';

const api = window.api;
const el = (id) => document.getElementById(id);
let deadline = Date.now() + WARNING_SECONDS * 1000;
let answered = false;

function answer(action, minutes) {
    if (answered) return;
    answered = true;
    api?.breaks?.answerWarning?.(action, minutes);
}

function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el('count').textContent = `${left} sec`;
    // The countdown ran out: the break starts.
    if (left === 0) answer('start');
}

function init() {
    const select = el('minutes');
    for (const minutes of POSTPONE_OPTIONS) {
        const option = document.createElement('option');
        option.value = String(minutes);
        option.textContent = `${minutes} min`;
        select.append(option);
    }
    select.value = String(DEFAULT_POSTPONE_MINUTES);
    select.addEventListener('change', () => {
        el('postpone').textContent = postponeLabel(normalisePostpone(select.value));
    });

    el('start').addEventListener('click', () => answer('start'));
    el('skip').addEventListener('click', () => answer('skip'));
    el('postpone').addEventListener('click', () => answer('postpone', normalisePostpone(select.value)));

    api?.breaks?.getWarning?.().then((warning) => {
        if (!warning) return;
        el('title').textContent = warningTitle(warning.seconds);
        if (Number.isFinite(warning.deadline)) deadline = warning.deadline;
        tick();
    }).catch(() => {});

    api?.getTheme?.().then((theme) => {
        document.documentElement.dataset.theme = normaliseTheme(theme);
    }).catch(() => {});

    tick();
    setInterval(tick, 250);
}

init();
