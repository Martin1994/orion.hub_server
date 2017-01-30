/*******************************************************************************
 * @license
 * Copyright (c) 2017 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License v1.0
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html).
 *
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/

module.exports = {
	//jwt_secret needs to be the same as the one in the server connected to the filesystem (orion)
	'jwt_secret': "pomato (potato and tomato mix lol)",
	'orion': "http://localhost:8081/",
	'fileLoadUrl': "sharedWorkspace/tree/load/",
	'fileSaveUrl': "sharedWorkspace/tree/save/",
	'saveFrequecy': 10
}
