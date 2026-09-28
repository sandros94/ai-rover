import { defineAccountHandler } from '../../utils/account'

/** The signed-in user's account: its identities and which one it shows. */
export default defineAccountHandler(async (_event, { user }) => user)
