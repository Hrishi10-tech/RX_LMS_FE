/**
 * Ambient globals.
 *
 * The window-level call bridges (__voiceCall / __videoCall / __groupCall /
 * __callUpgrade) were removed with the voice + video feature. Chat needs no
 * such bridge — it goes through the socket and the normal React tree.
 */
export {};
