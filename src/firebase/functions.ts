import { getFunctions } from 'firebase/functions';
import { app } from './config';

export const functions = getFunctions(app, 'us-central1');
