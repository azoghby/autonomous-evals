export const fixtureSession: { viewer: {id: string; isOperator: boolean} | null } = { viewer: null };
export const getCurrentCustomer = async () => fixtureSession.viewer;
