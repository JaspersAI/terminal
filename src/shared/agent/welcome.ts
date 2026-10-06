// What the assistant says on its own to welcome a new user, once setup is done and the workspace is
// on screen: a greeting, what the terminal is, then one example of a request, which the model writes
// from what is installed. The first two are written here; main says them a few seconds apart, and
// asks the model for the third with the instruction below. Pure: the words, and nothing about time.

/**
 * The turn in front of each welcome message in a workspace's thread. The message is the assistant's own
 * turn; this says what it is, in the user's place, since a user's turn is what the user typed and the
 * welcome must never pass for that. The transcript hides it and shows the message as said unasked.
 */
export const WELCOME_NOTE =
  '(The reply below is one of the messages the assistant says on its own to welcome the user after setup, not an answer to anything the user typed.)'

export const GREETING = 'Hi, I’m Jaspers, the assistant in this terminal. Welcome.'

/** What the terminal is, and how to speak to it: talking first, since that is the way in we want taken. */
export const EXPLANATION = [
  'This is a workspace for financial research: a grid, and plugins that bring it views and data.',
  'Ask me for something and I put the right view on the grid, fill it, and keep it current.',
  'The easiest way is to talk: choose Talk below and hold the orb while you speak. Typing here works any time too.',
].join(' ')

/**
 * What the model is asked for the third message, in a thread of its own with no tools: it knows what
 * is installed from the system prompt, and the answer is the message. Said as a note, so it reads as
 * the app's instruction and not the user's words.
 */
export const EXAMPLE_ASK =
  '(The user has just finished setting up Jaspers Terminal and is looking at an empty workspace. You have greeted them and said what the terminal is; this is the third and last message of that welcome. Give them one example of something they could ask you for with what is installed: say what it uses, and word the request as something they could type, in quotes. Two or three short sentences, nothing else. With no plugin installed, take the example from the built-in views.)'

/** The third message when the model could not be asked, or answered with nothing. */
export const EXAMPLE_FALLBACK =
  'Try me with something small: "put a note on the grid with my watchlist". Settings > Plugins adds more to ask for.'

/** In the system prompt of that run, since the rest of it speaks of tools the run does not have. */
export const WELCOME_PREFACE =
  'This one request is the app welcoming a new user, not the user typing, and it comes with no tools: answer in text alone.'
