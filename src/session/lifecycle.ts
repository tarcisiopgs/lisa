import { createConnection } from "node:net";

export function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

export function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (Date.now() > deadline) {
				resolve(false);
				return;
			}
			isPortInUse(port).then((inUse) => {
				if (inUse) {
					resolve(true);
				} else {
					setTimeout(check, 500);
				}
			});
		};
		check();
	});
}
