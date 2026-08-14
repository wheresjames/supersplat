import { math, Vec3 } from 'playcanvas';

import { Camera } from './camera';

type Touch = {
    id: number;
    x: number;
    y: number;
};

const distance2d = (x0: number, y0: number, x1: number, y1: number) =>
    Math.hypot(x1 - x0, y1 - y0);

/**
 * Optional inertial camera controls. Pointer input adds velocity and update()
 * integrates that velocity using a nonlinear response curve and time-based
 * decay. The standard PointerController remains the default.
 */
class WjMovementController {
    update: (deltaTime: number) => void;
    destroy: () => void;

    constructor(camera: Camera, target: HTMLElement) {
        const config = camera.scene.config.controls.wjmovement;
        const angularVelocity = new Vec3();
        const panVelocity = new Vec3();
        let zoomVelocity = 0;
        let wheelVelocity = 0;
        let pressedButton = -1;
        let x = 0;
        let y = 0;
        let touches: Touch[] = [];
        let touchMidX = 0;
        let touchMidY = 0;
        let touchDistance = 0;

        const response = (value: number) => {
            const magnitude = Math.abs(value);
            return Math.sign(value) * Math.pow(magnitude, config.acceleration) / config.acceleration;
        };

        // Keep the response of a typical isolated wheel event unchanged, then
        // scale only the extra nonlinear response produced by faster scrolling.
        const wheelResponse = (value: number) => {
            const magnitude = Math.abs(value);
            const pivot = 0.3;
            if (magnitude <= pivot) return response(value);

            const baseline = Math.pow(pivot, config.acceleration) / config.acceleration;
            const accelerated = Math.pow(magnitude, config.acceleration) / config.acceleration;
            return Math.sign(value) * (baseline + (accelerated - baseline) * Math.max(0, config.wheelAccelerationScale));
        };

        const addOrbit = (dx: number, dy: number) => {
            angularVelocity.x += dx * config.orbitInputScale;
            angularVelocity.y += dy * config.orbitInputScale;
        };

        const addPan = (dx: number, dy: number) => {
            panVelocity.x += dx * config.panInputScale;
            panVelocity.y += dy * config.panInputScale;
        };

        const addZoom = (amount: number) => {
            zoomVelocity += amount * config.zoomInputScale;
        };

        const pointerdown = (event: PointerEvent) => {
            target.setPointerCapture(event.pointerId);
            if (event.pointerType === 'mouse') {
                if (pressedButton !== -1) return;
                pressedButton = event.button;
                x = event.offsetX;
                y = event.offsetY;
            } else if (!touches.some(touch => touch.id === event.pointerId)) {
                touches.push({ id: event.pointerId, x: event.offsetX, y: event.offsetY });
                if (touches.length === 2) {
                    touchMidX = (touches[0].x + touches[1].x) * 0.5;
                    touchMidY = (touches[0].y + touches[1].y) * 0.5;
                    touchDistance = distance2d(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
                }
            }
        };

        const pointerup = (event: PointerEvent) => {
            if (event.pointerType === 'mouse') {
                if (event.button === pressedButton) pressedButton = -1;
            } else {
                touches = touches.filter(touch => touch.id !== event.pointerId);
            }
            if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
        };

        const pointermove = (event: PointerEvent) => {
            if (event.pointerType === 'mouse') {
                if (pressedButton === -1) return;
                const dx = event.offsetX - x;
                const dy = event.offsetY - y;
                x = event.offsetX;
                y = event.offsetY;

                if (pressedButton === 0) addOrbit(dx, dy);
                else if (pressedButton === 1) addZoom(-dy);
                else if (pressedButton === 2) addPan(dx, dy);
                return;
            }

            const touch = touches.find(item => item.id === event.pointerId);
            if (!touch) return;
            const dx = event.offsetX - touch.x;
            const dy = event.offsetY - touch.y;
            touch.x = event.offsetX;
            touch.y = event.offsetY;

            if (touches.length === 1) {
                addOrbit(dx, dy);
            } else if (touches.length === 2) {
                const midX = (touches[0].x + touches[1].x) * 0.5;
                const midY = (touches[0].y + touches[1].y) * 0.5;
                const nextDistance = distance2d(touches[0].x, touches[0].y, touches[1].x, touches[1].y);
                addPan(midX - touchMidX, midY - touchMidY);
                addZoom(nextDistance - touchDistance);
                touchMidX = midX;
                touchMidY = midY;
                touchDistance = nextDistance;
            }
        };

        const wheel = (event: WheelEvent) => {
            // Normalize line/page deltas to pixels, then use a dedicated lower
            // scale than pinch and middle-button drag. Successive wheel events
            // accumulate velocity, and the nonlinear response in update()
            // makes slow scrolling precise while fast scrolling ramps up.
            const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
                (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? target.clientHeight : 1);
            const delta = Math.max(-200, Math.min(200, event.deltaY * modeScale));
            wheelVelocity += -delta * config.wheelInputScale;
            event.preventDefault();
        };

        const dblclick = (event: MouseEvent) => {
            camera.pickFocalPoint(event.offsetX / target.clientWidth, event.offsetY / target.clientHeight);
        };

        const stopInput = () => {
            pressedButton = -1;
            touches = [];
        };

        const pan = (dx: number, dy: number) => {
            const transform = camera.worldTransform;
            const distance = camera.distance * camera.sceneRadius / camera.fovFactor;
            const scale = Math.min(distance * 25, 50);
            const movement = transform.getX().mulScalar(-dx * scale);
            movement.add(transform.getY().mulScalar(dy * scale));
            camera.setFocalPoint(camera.focalPoint.add(movement), 0);
        };

        const zoom = (amount: number) => {
            if (camera.controlMode === 'fly') {
                const movement = camera.worldTransform.getZ().mulScalar(-amount * 10);
                camera.setFocalPoint(camera.focalPoint.add(movement), 0);
                return;
            }

            const worldDistance = camera.distance * camera.sceneRadius / camera.fovFactor;
            const nextWorldDistance = worldDistance - amount * worldDistance;
            const minimum = config.minimumDistance;

            if (config.pushFocusPoint && nextWorldDistance < minimum && amount > 0) {
                const overshoot = minimum - nextWorldDistance;
                const forward = new Vec3();
                Camera.calcForwardVec(forward, camera.azim, camera.elevation);
                camera.setFocalPoint(camera.focalPoint.sub(forward.mulScalar(overshoot)), 0);
                camera.setDistance(minimum / camera.sceneRadius * camera.fovFactor, 0);
            } else {
                const clamped = Math.max(minimum, nextWorldDistance);
                camera.setDistance(clamped / camera.sceneRadius * camera.fovFactor, 0);
            }
        };

        this.update = (deltaTime: number) => {
            const dt = Math.min(deltaTime, 0.1);
            if (Math.abs(angularVelocity.x) >= config.threshold || Math.abs(angularVelocity.y) >= config.threshold) {
                const dx = response(angularVelocity.x) * dt * math.RAD_TO_DEG;
                const dy = response(angularVelocity.y) * dt * math.RAD_TO_DEG;
                if (camera.controlMode === 'fly') {
                    camera.look(dx, dy);
                } else {
                    const elevation = Math.max(config.minElevation, Math.min(config.maxElevation, camera.elevation + dy));
                    camera.setAzimElev(camera.azim + dx, elevation, 0);
                }
            }
            if (Math.abs(panVelocity.x) >= config.threshold || Math.abs(panVelocity.y) >= config.threshold) {
                pan(response(panVelocity.x) * dt, response(panVelocity.y) * dt);
            }
            if (Math.abs(zoomVelocity) >= config.threshold) zoom(response(zoomVelocity) * dt);
            if (Math.abs(wheelVelocity) >= config.threshold) zoom(wheelResponse(wheelVelocity) * dt);

            const decay = Math.pow(config.decay, dt * 60);
            angularVelocity.mulScalar(decay);
            panVelocity.mulScalar(decay);
            zoomVelocity *= decay;
            wheelVelocity *= decay;
            if (Math.abs(angularVelocity.x) < config.threshold) angularVelocity.x = 0;
            if (Math.abs(angularVelocity.y) < config.threshold) angularVelocity.y = 0;
            if (Math.abs(panVelocity.x) < config.threshold) panVelocity.x = 0;
            if (Math.abs(panVelocity.y) < config.threshold) panVelocity.y = 0;
            if (Math.abs(zoomVelocity) < config.threshold) zoomVelocity = 0;
            if (Math.abs(wheelVelocity) < config.threshold) wheelVelocity = 0;
        };

        const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];
        const listen = (eventTarget: EventTarget, name: string, callback: EventListener, options?: AddEventListenerOptions) => {
            const wrapped: EventListener = (event) => {
                camera.scene.events.fire('camera.controller', name);
                callback(event);
            };
            eventTarget.addEventListener(name, wrapped, options);
            listeners.push([eventTarget, name, wrapped, options]);
        };

        listen(target, 'pointerdown', pointerdown as EventListener);
        listen(target, 'pointerup', pointerup as EventListener);
        listen(target, 'pointercancel', pointerup as EventListener);
        listen(target, 'pointermove', pointermove as EventListener);
        listen(target, 'wheel', wheel as EventListener, { passive: false });
        listen(target, 'dblclick', dblclick as EventListener);
        listen(window, 'blur', stopInput);

        this.destroy = () => {
            listeners.forEach(([eventTarget, name, callback, options]) =>
                eventTarget.removeEventListener(name, callback, options));
        };
    }
}

export { WjMovementController };
