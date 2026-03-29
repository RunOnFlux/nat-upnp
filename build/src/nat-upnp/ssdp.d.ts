/// <reference types="node" />
import EventEmitter from "events";
/**
 * SSDP discovery. Finds UPnP devices on the local network via multicast.
 * Emits device Location URLs — does not resolve local addresses (that's the caller's job).
 */
export declare class Ssdp implements ISsdp {
    private readonly sourcePort;
    private readonly multicast;
    private readonly port;
    private readonly ssdpEmitter;
    private socket;
    private bound;
    private closed;
    private readonly pendingSearches;
    constructor(options?: {
        sourcePort?: number;
    });
    private ensureSocket;
    private parseResponse;
    search(device: string, emitter?: SsdpEmitter): SsdpEmitter;
    close(): void;
}
export default Ssdp;
type SearchArgs = [Record<string, string>];
export type SearchCallback = (...args: SearchArgs) => void;
type SearchEvent = <E extends Events>(ev: E, ...args: E extends "device" ? SearchArgs : []) => boolean;
type Events = "device" | "end";
type Event<E extends Events> = E extends "device" ? SearchCallback : () => void;
type EventListener<T> = <E extends Events>(ev: E, callback: Event<E>) => T;
export interface SsdpEmitter extends EventEmitter {
    removeListener: EventListener<this>;
    addListener: EventListener<this>;
    once: EventListener<this>;
    on: EventListener<this>;
    emit: SearchEvent;
}
export interface ISsdp {
    search(device: string, emitter?: SsdpEmitter): SsdpEmitter;
    close(): void;
}
